import type { CliDeps } from "../../cli/deps.js";
import { createDefaultDeps } from "../../cli/deps.js";
import { defaultRuntime, type RuntimeEnv } from "../../runtime.js";
import { logWarn } from "../../logger.js";
import type { WorkJobRecord, WorkJobResult } from "./types.js";
import {
  claimNextQueuedJob,
  completeJob,
  failJob,
  heartbeatJob,
  recoverStaleRunningJobs,
} from "./store.js";

const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 20_000;
const DEFAULT_IDLE_POLL_MS = 1_000;
const DEFAULT_MAX_PARALLEL = 4;

export type WorkJobRunner = (job: WorkJobRecord) => Promise<WorkJobResult>;

type WorkerOptions = {
  runJob?: WorkJobRunner;
  runtime?: RuntimeEnv;
  deps?: CliDeps;
  leaseMs?: number;
  heartbeatIntervalMs?: number;
  idlePollMs?: number;
  maxParallel?: number;
};

export class WorkJobWorker {
  private readonly runJob: WorkJobRunner;
  private readonly leaseMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly idlePollMs: number;
  private readonly maxParallel: number;
  private stopped = false;
  private inFlight = 0;
  private loopPromise: Promise<void> | null = null;
  private readonly awake = new AwakeSignal();

  constructor(opts: WorkerOptions = {}) {
    const runtime = opts.runtime ?? defaultRuntime;
    const deps = opts.deps ?? createDefaultDeps();
    this.runJob =
      opts.runJob ?? ((job: WorkJobRecord) => defaultRunJob(job, runtime, deps));
    this.leaseMs = opts.leaseMs ?? DEFAULT_LEASE_MS;
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.idlePollMs = opts.idlePollMs ?? DEFAULT_IDLE_POLL_MS;
    this.maxParallel = Math.max(1, opts.maxParallel ?? DEFAULT_MAX_PARALLEL);
  }

  start(): void {
    if (this.loopPromise) {
      return;
    }
    const recovered = recoverStaleRunningJobs();
    if (recovered.length > 0) {
      logWarn(
        `work-jobs: recovered ${recovered.length} stale running jobs from previous process`,
      );
    }
    this.loopPromise = this.loop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.awake.signal();
    if (this.loopPromise) {
      await this.loopPromise;
    }
  }

  /** Called when a new job is enqueued so the worker can pick it up immediately. */
  notify(): void {
    this.awake.signal();
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      if (this.inFlight >= this.maxParallel) {
        await this.awake.wait(this.idlePollMs);
        continue;
      }
      const job = claimNextQueuedJob({ leaseMs: this.leaseMs });
      if (!job) {
        await this.awake.wait(this.idlePollMs);
        continue;
      }
      this.inFlight += 1;
      void this.execute(job).finally(() => {
        this.inFlight -= 1;
        this.awake.signal();
      });
    }
    // Wait for in-flight work to drain on shutdown.
    while (this.inFlight > 0) {
      await this.awake.wait(50);
    }
  }

  private async execute(job: WorkJobRecord): Promise<void> {
    const leaseToken = job.leaseToken ?? "";
    const heartbeat = setInterval(() => {
      heartbeatJob({
        jobId: job.jobId,
        leaseToken,
        leaseMs: this.leaseMs,
      });
    }, this.heartbeatIntervalMs);
    try {
      const result = await this.runJob(job);
      completeJob({ jobId: job.jobId, leaseToken, result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logWarn(`work-jobs: job ${job.jobId} failed: ${message}`);
      failJob({ jobId: job.jobId, leaseToken, error: message });
    } finally {
      clearInterval(heartbeat);
    }
  }
}

class AwakeSignal {
  private resolver: (() => void) | null = null;

  signal(): void {
    const resolve = this.resolver;
    this.resolver = null;
    resolve?.();
  }

  wait(timeoutMs: number): Promise<void> {
    if (this.resolver) {
      // Coalesce multiple waiters — the signaller resolves whichever is latest.
      const previous = this.resolver;
      this.resolver = () => {
        previous();
      };
    }
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.resolver = null;
        resolve();
      }, timeoutMs);
      const wrapped = () => {
        clearTimeout(timer);
        resolve();
      };
      this.resolver = wrapped;
    });
  }
}

async function defaultRunJob(
  job: WorkJobRecord,
  runtime: RuntimeEnv,
  deps: CliDeps,
): Promise<WorkJobResult> {
  // Lazy-load agent-command so that test harnesses that don't start the worker do not pull
  // in the entire agent runtime at module load time.
  const { agentCommandFromIngress } = await import("../../agents/agent-command.js");
  const runId = `workjob_${job.jobId}`;
  const systemPrompt = job.inputs.systemPrompt?.trim() || undefined;
  const message = job.inputs.userMessage;
  const sessionKey = job.inputs.sessionKey?.trim() || `work-jobs:${job.workContextId}`;
  const messageChannel = job.inputs.messageChannel?.trim() || "webchat";
  const commandInput = {
    message,
    extraSystemPrompt: systemPrompt,
    sessionKey,
    runId,
    deliver: false as const,
    messageChannel,
    bestEffortDeliver: false as const,
    senderIsOwner: true,
    allowModelOverride: true as const,
    model: job.inputs.model?.trim() || undefined,
    hiddenEnv: job.inputs.hiddenEnv,
  };
  const raw = (await agentCommandFromIngress(commandInput, runtime, deps)) as {
    payloads?: Array<{ text?: string }>;
    meta?: {
      agentMeta?: {
        usage?: {
          input?: number;
          output?: number;
          total?: number;
        };
      };
    };
  };
  const payloads = Array.isArray(raw?.payloads) ? raw.payloads : [];
  const content = payloads
    .map((p) => (typeof p.text === "string" ? p.text : ""))
    .filter(Boolean)
    .join("\n\n");
  const usage = raw?.meta?.agentMeta?.usage;
  return {
    content: content || undefined,
    sessionKey,
    turnId: runId,
    usage: usage
      ? {
          promptTokens: usage.input,
          completionTokens: usage.output,
          totalTokens: usage.total,
        }
      : undefined,
  };
}
