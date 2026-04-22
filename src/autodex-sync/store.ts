import { randomUUID } from "node:crypto";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { loadJsonFile } from "../infra/json-file.js";
import { writeJsonFileAtomically } from "../plugin-sdk/json-store.js";
import type { AutodexIngestEvent, AutodexIngestSession, PendingEntry } from "./types.js";

/**
 * File-backed FIFO queue for Autodex ingest entries. Mirrors the work-jobs
 * store pattern (JSON file at <stateDir>/gateway/, atomic writes via
 * writeJsonFileAtomically) so a VM crash or temporary Autodex outage doesn't
 * lose transcript lines already emitted by the transcript tap.
 *
 * Scope intentionally small: enqueue (listener), claim-due (worker), ack
 * (worker on success), bump-retry (worker on failure). No leasing — only one
 * worker runs at a time inside the gateway process.
 */

const FILE_VERSION = 1;
const MAX_ENTRIES = 10_000;
const PERSIST_PATH_FILE = "autodex-sync-pending.json";

type PersistedFile = {
  version: 1;
  entries: PendingEntry[];
};

const entriesById = new Map<string, PendingEntry>();
const entriesOrder: string[] = [];
let loaded = false;
let persistChain: Promise<void> = Promise.resolve();
let pathOverride: string | null = null;

function resolvePath(env: NodeJS.ProcessEnv = process.env): string {
  if (pathOverride) {
    return pathOverride;
  }
  return path.join(resolveStateDir(env), "gateway", PERSIST_PATH_FILE);
}

function loadIntoMemory(): void {
  if (loaded) {
    return;
  }
  loaded = true;
  entriesById.clear();
  entriesOrder.length = 0;

  const parsed = loadJsonFile(resolvePath()) as PersistedFile | undefined;
  const entries = parsed?.version === FILE_VERSION ? parsed.entries : [];
  for (const entry of entries ?? []) {
    if (!entry?.id || !entry.session?.session_key || !entry.event?.event_type) {
      continue;
    }
    entriesById.set(entry.id, entry);
    entriesOrder.push(entry.id);
  }
}

function schedulePersist(): void {
  persistChain = persistChain
    .catch(() => {})
    .then(async () => {
      await writeJsonFileAtomically(resolvePath(), {
        version: FILE_VERSION,
        entries: entriesOrder.map((id) => entriesById.get(id)).filter(Boolean) as PendingEntry[],
      } satisfies PersistedFile);
    });
}

function evictOverflow(): void {
  while (entriesOrder.length > MAX_ENTRIES) {
    const oldestId = entriesOrder.shift();
    if (oldestId) {
      entriesById.delete(oldestId);
    }
  }
}

export function enqueuePending(params: {
  session: AutodexIngestSession;
  event: AutodexIngestEvent;
  now?: number;
}): PendingEntry {
  loadIntoMemory();
  const now = params.now ?? Date.now();
  const entry: PendingEntry = {
    id: randomUUID(),
    enqueuedAt: now,
    attempts: 0,
    nextAttemptAt: now,
    session: params.session,
    event: params.event,
  };
  entriesById.set(entry.id, entry);
  entriesOrder.push(entry.id);
  evictOverflow();
  schedulePersist();
  return entry;
}

/**
 * Returns entries eligible to be flushed now, grouped by session_key so the
 * worker can emit one HTTP request per session. Each group preserves the
 * original enqueue order. Entries still serving a backoff delay are skipped.
 */
export function claimDueGroups(params: {
  now?: number;
  maxEntries?: number;
}): Map<string, PendingEntry[]> {
  loadIntoMemory();
  const now = params.now ?? Date.now();
  const limit = params.maxEntries ?? 500;
  const groups = new Map<string, PendingEntry[]>();
  let taken = 0;

  for (const id of entriesOrder) {
    if (taken >= limit) {
      break;
    }
    const entry = entriesById.get(id);
    if (!entry) {
      continue;
    }
    if (entry.nextAttemptAt > now) {
      continue;
    }
    const bucket = groups.get(entry.session.session_key) ?? [];
    bucket.push(entry);
    groups.set(entry.session.session_key, bucket);
    taken += 1;
  }
  return groups;
}

export function ackEntries(ids: string[]): void {
  if (!ids.length) {
    return;
  }
  loadIntoMemory();
  const removing = new Set(ids);
  for (const id of removing) {
    entriesById.delete(id);
  }
  for (let i = entriesOrder.length - 1; i >= 0; i--) {
    if (removing.has(entriesOrder[i])) {
      entriesOrder.splice(i, 1);
    }
  }
  schedulePersist();
}

/**
 * Apply exponential backoff to the supplied entries — capped at 10 minutes so
 * a dead Autodex doesn't starve fresh events forever.
 */
export function bumpRetry(ids: string[], now: number = Date.now()): void {
  if (!ids.length) {
    return;
  }
  loadIntoMemory();
  const maxDelayMs = 10 * 60 * 1000;
  for (const id of ids) {
    const entry = entriesById.get(id);
    if (!entry) {
      continue;
    }
    entry.attempts += 1;
    const baseDelay = Math.min(1_000 * 2 ** Math.min(entry.attempts, 10), maxDelayMs);
    entry.nextAttemptAt = now + baseDelay;
  }
  schedulePersist();
}

export function pendingCount(): number {
  loadIntoMemory();
  return entriesOrder.length;
}

export const __testing = {
  async flushPersist(): Promise<void> {
    await persistChain;
  },
  reset(params?: { customPath?: string | null }): void {
    entriesById.clear();
    entriesOrder.length = 0;
    loaded = false;
    persistChain = Promise.resolve();
    if (params && "customPath" in params) {
      pathOverride = params.customPath ?? null;
    }
  },
  list(): PendingEntry[] {
    loadIntoMemory();
    return entriesOrder.map((id) => entriesById.get(id)!).filter(Boolean);
  },
  limits: {
    maxEntries: MAX_ENTRIES,
  },
};
