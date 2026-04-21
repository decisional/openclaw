import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../../config/paths.js";
import { loadJsonFile } from "../../infra/json-file.js";
import { writeJsonFileAtomically } from "../../plugin-sdk/json-store.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import type { WorkJobInputs, WorkJobRecord, WorkJobResult, WorkJobState } from "./types.js";

const FILE_VERSION = 1;
const JOB_ID_PREFIX = "wj_";

// Once a job has reached a terminal state, we keep its record around for this long so that
// duplicate dispatches from Autodex still see "already completed" instead of kicking off a
// new turn. The TTL is long enough to outlive normal HITL/fixer cadences.
const TERMINAL_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_RECORDS = 5_000;

type PersistedWorkJobsFile = {
  version: 1;
  jobs: WorkJobRecord[];
};

const jobsByWorkContext = new Map<string, WorkJobRecord>();
const jobsById = new Map<string, WorkJobRecord>();
let loaded = false;
let persistPromise: Promise<void> = Promise.resolve();
let testPathOverride: string | null = null;

function resolveJobsPath(env: NodeJS.ProcessEnv = process.env): string {
  if (testPathOverride) {
    return testPathOverride;
  }
  return path.join(resolveStateDir(env), "gateway", "work-jobs.json");
}

function normalizeValue(value: string | undefined | null): string {
  return normalizeOptionalString(value) ?? "";
}

function isTerminal(state: WorkJobState): boolean {
  return state === "completed" || state === "failed" || state === "cancelled";
}

function pruneExpired(now: number): boolean {
  let removed = false;
  for (const [key, job] of jobsByWorkContext) {
    if (isTerminal(job.state) && now - job.updatedAt > TERMINAL_RETENTION_MS) {
      jobsByWorkContext.delete(key);
      jobsById.delete(job.jobId);
      removed = true;
    }
  }
  return removed;
}

function evictOverflow(): boolean {
  let removed = false;
  while (jobsByWorkContext.size > MAX_RECORDS) {
    // Insertion order on Map — oldest insertion goes first. We only evict terminal jobs so
    // that in-flight work is never silently dropped.
    let evicted: string | undefined;
    for (const [key, job] of jobsByWorkContext) {
      if (isTerminal(job.state)) {
        evicted = key;
        break;
      }
    }
    if (!evicted) {
      break;
    }
    const evictedJob = jobsByWorkContext.get(evicted);
    jobsByWorkContext.delete(evicted);
    if (evictedJob) {
      jobsById.delete(evictedJob.jobId);
    }
    removed = true;
  }
  return removed;
}

function compact(now: number): boolean {
  const pruned = pruneExpired(now);
  const evicted = evictOverflow();
  return pruned || evicted;
}

function loadIntoMemory(): void {
  if (loaded) {
    return;
  }
  loaded = true;
  jobsByWorkContext.clear();
  jobsById.clear();
  const parsed = loadJsonFile(resolveJobsPath()) as PersistedWorkJobsFile | undefined;
  const jobs = parsed?.version === FILE_VERSION ? parsed.jobs : [];
  for (const job of jobs ?? []) {
    const workContextId = normalizeValue(job?.workContextId);
    const jobId = normalizeValue(job?.jobId);
    if (!workContextId || !jobId) {
      continue;
    }
    const record: WorkJobRecord = {
      ...job,
      workContextId,
      jobId,
      state: job.state ?? "queued",
      attempts: typeof job.attempts === "number" && Number.isFinite(job.attempts) ? job.attempts : 0,
      createdAt: typeof job.createdAt === "number" ? job.createdAt : Date.now(),
      updatedAt: typeof job.updatedAt === "number" ? job.updatedAt : Date.now(),
    };
    jobsByWorkContext.set(workContextId, record);
    jobsById.set(jobId, record);
  }
  compact(Date.now());
}

function toPersistedFile(): PersistedWorkJobsFile {
  return {
    version: FILE_VERSION,
    jobs: [...jobsByWorkContext.values()].toSorted((a, b) => a.jobId.localeCompare(b.jobId)),
  };
}

async function persist(): Promise<void> {
  compact(Date.now());
  await writeJsonFileAtomically(resolveJobsPath(), toPersistedFile());
}

function enqueuePersist(): Promise<void> {
  persistPromise = persistPromise
    .catch(() => {})
    .then(async () => {
      await persist();
    });
  return persistPromise;
}

function buildJobId(): string {
  return `${JOB_ID_PREFIX}${randomUUID().replaceAll("-", "")}`;
}

/**
 * Ensure a job exists for the given workContextId and return the current state.
 * Idempotent: if a job already exists, its state is returned unchanged.
 */
export function ensureJob(params: {
  workContextId: string;
  inputs: WorkJobInputs;
  now?: number;
}): WorkJobRecord {
  const workContextId = normalizeValue(params.workContextId);
  if (!workContextId) {
    throw new Error("work_context_id is required");
  }
  if (!normalizeValue(params.inputs.userMessage)) {
    throw new Error("user_message is required");
  }
  loadIntoMemory();
  const existing = jobsByWorkContext.get(workContextId);
  if (existing) {
    return existing;
  }
  const now = params.now ?? Date.now();
  const job: WorkJobRecord = {
    jobId: buildJobId(),
    workContextId,
    state: "queued",
    inputs: {
      userMessage: normalizeValue(params.inputs.userMessage),
      systemPrompt: normalizeValue(params.inputs.systemPrompt) || undefined,
      messageChannel: normalizeValue(params.inputs.messageChannel) || undefined,
      model: normalizeValue(params.inputs.model) || undefined,
      sessionKey: normalizeValue(params.inputs.sessionKey) || undefined,
    },
    createdAt: now,
    updatedAt: now,
    attempts: 0,
  };
  jobsByWorkContext.set(workContextId, job);
  jobsById.set(job.jobId, job);
  void enqueuePersist();
  return job;
}

/**
 * Reset a failed job back to queued so it can be re-run. No-op for non-failed jobs.
 */
export function requeueFailed(workContextId: string, now: number = Date.now()): WorkJobRecord | null {
  loadIntoMemory();
  const job = jobsByWorkContext.get(normalizeValue(workContextId));
  if (!job) {
    return null;
  }
  if (job.state !== "failed") {
    return job;
  }
  job.state = "queued";
  job.updatedAt = now;
  job.error = undefined;
  job.leaseExpiresAt = undefined;
  job.leaseToken = undefined;
  void enqueuePersist();
  return job;
}

export function getJobById(jobId: string): WorkJobRecord | null {
  loadIntoMemory();
  return jobsById.get(normalizeValue(jobId)) ?? null;
}

export function getJobByWorkContext(workContextId: string): WorkJobRecord | null {
  loadIntoMemory();
  return jobsByWorkContext.get(normalizeValue(workContextId)) ?? null;
}

/**
 * Claim the next queued job for processing. Returns null if nothing to do.
 * Sets state=running, bumps attempts, and attaches a lease.
 */
export function claimNextQueuedJob(params: {
  leaseMs: number;
  now?: number;
}): WorkJobRecord | null {
  loadIntoMemory();
  const now = params.now ?? Date.now();
  // Recover orphaned running jobs whose lease has expired.
  for (const job of jobsByWorkContext.values()) {
    if (job.state === "running" && job.leaseExpiresAt && job.leaseExpiresAt < now) {
      job.state = "queued";
      job.updatedAt = now;
      job.leaseExpiresAt = undefined;
      job.leaseToken = undefined;
    }
  }
  for (const job of jobsByWorkContext.values()) {
    if (job.state !== "queued") {
      continue;
    }
    job.state = "running";
    job.attempts += 1;
    job.startedAt = job.startedAt ?? now;
    job.updatedAt = now;
    job.leaseExpiresAt = now + params.leaseMs;
    job.leaseToken = randomUUID();
    void enqueuePersist();
    return job;
  }
  return null;
}

export function heartbeatJob(params: {
  jobId: string;
  leaseToken: string;
  leaseMs: number;
  now?: number;
}): boolean {
  loadIntoMemory();
  const job = jobsById.get(normalizeValue(params.jobId));
  if (!job) {
    return false;
  }
  if (job.state !== "running" || job.leaseToken !== params.leaseToken) {
    return false;
  }
  const now = params.now ?? Date.now();
  job.leaseExpiresAt = now + params.leaseMs;
  job.updatedAt = now;
  void enqueuePersist();
  return true;
}

export function completeJob(params: {
  jobId: string;
  leaseToken: string;
  result: WorkJobResult;
  now?: number;
}): boolean {
  loadIntoMemory();
  const job = jobsById.get(normalizeValue(params.jobId));
  if (!job) {
    return false;
  }
  if (job.state !== "running" || job.leaseToken !== params.leaseToken) {
    return false;
  }
  const now = params.now ?? Date.now();
  job.state = "completed";
  job.result = params.result;
  job.completedAt = now;
  job.updatedAt = now;
  job.leaseExpiresAt = undefined;
  job.leaseToken = undefined;
  void enqueuePersist();
  return true;
}

export function failJob(params: {
  jobId: string;
  leaseToken: string;
  error: string;
  now?: number;
}): boolean {
  loadIntoMemory();
  const job = jobsById.get(normalizeValue(params.jobId));
  if (!job) {
    return false;
  }
  if (job.state !== "running" || job.leaseToken !== params.leaseToken) {
    return false;
  }
  const now = params.now ?? Date.now();
  job.state = "failed";
  job.error = params.error;
  job.completedAt = now;
  job.updatedAt = now;
  job.leaseExpiresAt = undefined;
  job.leaseToken = undefined;
  void enqueuePersist();
  return true;
}

/**
 * Recover any jobs stuck in running from a crashed process. Called at worker startup.
 */
export function recoverStaleRunningJobs(now: number = Date.now()): WorkJobRecord[] {
  loadIntoMemory();
  const recovered: WorkJobRecord[] = [];
  for (const job of jobsByWorkContext.values()) {
    if (job.state === "running" && (!job.leaseExpiresAt || job.leaseExpiresAt < now)) {
      job.state = "queued";
      job.updatedAt = now;
      job.leaseExpiresAt = undefined;
      job.leaseToken = undefined;
      recovered.push(job);
    }
  }
  if (recovered.length > 0) {
    void enqueuePersist();
  }
  return recovered;
}

/**
 * Record the first Slack post for this work item so duplicate posts can be suppressed.
 * Returns false if a post was already recorded (caller should skip), true if this is the first.
 */
export function recordFirstSlackPost(params: {
  workContextId: string;
  now?: number;
}): boolean {
  loadIntoMemory();
  const job = jobsByWorkContext.get(normalizeValue(params.workContextId));
  if (!job) {
    return true; // no job tracked — don't block the post
  }
  if (job.slackPostedAt) {
    return false;
  }
  job.slackPostedAt = params.now ?? Date.now();
  job.updatedAt = job.slackPostedAt;
  void enqueuePersist();
  return true;
}

export const __testing = {
  async flushPersistForTests(): Promise<void> {
    await persistPromise;
  },
  reset(params?: { deletePersistedFile?: boolean; customPath?: string | null }) {
    jobsByWorkContext.clear();
    jobsById.clear();
    loaded = false;
    persistPromise = Promise.resolve();
    if (params?.customPath !== undefined) {
      testPathOverride = params.customPath;
    }
    if (params?.deletePersistedFile) {
      try {
        fs.rmSync(resolveJobsPath(), { force: true });
      } catch {
        // Best-effort cleanup for tests only.
      }
    }
  },
  list(): WorkJobRecord[] {
    loadIntoMemory();
    return [...jobsByWorkContext.values()].toSorted((a, b) => a.jobId.localeCompare(b.jobId));
  },
  limits: {
    terminalRetentionMs: TERMINAL_RETENTION_MS,
    maxRecords: MAX_RECORDS,
  },
};
