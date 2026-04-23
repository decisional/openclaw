import { postIngest, type AutodexSyncConfig } from "./client.js";
import { ackEntries, bumpRetry, claimDueGroups, pendingCount } from "./store.js";
import type { AutodexIngestEvent, AutodexIngestRequest, PendingEntry } from "./types.js";

export type AutodexSyncWorkerDeps = {
  cfg: AutodexSyncConfig;
  fetchFn?: typeof fetch;
  logger?: {
    debug?: (msg: string, meta?: Record<string, unknown>) => void;
    warn?: (msg: string, meta?: Record<string, unknown>) => void;
  };
  now?: () => number;
};

/**
 * runOneFlushCycle drains every session-group whose head entry is due,
 * posting one HTTP request per group. Returns a summary the sidecar can log
 * or the test can assert on. Runs fully sequentially — the workload is
 * per-VM and bursty at turn boundaries, not throughput-bound, and serial
 * execution keeps event ordering intact without a per-session lock.
 */
export async function runOneFlushCycle(deps: AutodexSyncWorkerDeps): Promise<{
  groupsAttempted: number;
  groupsSucceeded: number;
  entriesAcked: number;
  entriesRetried: number;
}> {
  const now = deps.now ? deps.now() : Date.now();
  const groups = claimDueGroups({ now });
  let groupsAttempted = 0;
  let groupsSucceeded = 0;
  let entriesAcked = 0;
  let entriesRetried = 0;

  for (const [sessionKey, entries] of groups) {
    if (!entries.length) {
      continue;
    }
    groupsAttempted += 1;
    const ids = entries.map((e) => e.id);
    const request: AutodexIngestRequest = {
      session: entries[0].session,
      events: entries.map((e) => dropEmptyFields(e.event)),
    };

    const result = await postIngest(deps.cfg, request, deps.fetchFn);
    if (result.ok) {
      ackEntries(ids);
      entriesAcked += ids.length;
      groupsSucceeded += 1;
      deps.logger?.debug?.(`autodex-sync flushed session ${sessionKey}`, {
        events: result.response.events_received,
        inserted: result.response.events_inserted,
        deduplicated: result.response.events_deduplicated,
      });
      continue;
    }

    if (!result.retryable) {
      // Permanent failure — drop the group rather than pile up retries that
      // can never succeed. A rotated token or unbound instance is operator
      // surface, not a reason to keep burning HTTP calls.
      ackEntries(ids);
      entriesAcked += ids.length;
      deps.logger?.warn?.(`autodex-sync permanent failure for session ${sessionKey}`, {
        status: result.status,
        error: result.error,
      });
      continue;
    }

    bumpRetry(ids, now);
    entriesRetried += ids.length;
    deps.logger?.warn?.(`autodex-sync retrying session ${sessionKey}`, {
      status: result.status,
      error: result.error,
      attempts: Math.max(...entries.map((e) => e.attempts)) + 1,
    });
  }

  return { groupsAttempted, groupsSucceeded, entriesAcked, entriesRetried };
}

/**
 * startAutodexSyncWorker kicks off a setInterval-based flush loop. Returns a
 * stop() function that clears the interval and finishes any in-flight cycle.
 *
 * Intervals are intentionally generous (2s default): transcript emission is
 * bursty at turn boundaries and we'd rather post a whole turn together than
 * paginate it into ten one-event requests. The loop self-schedules if a
 * cycle overruns so we never stack parallel flushes.
 */
export function startAutodexSyncWorker(
  deps: AutodexSyncWorkerDeps & { intervalMs?: number },
): () => void {
  const intervalMs = deps.intervalMs ?? 2_000;
  let stopped = false;
  let inFlight: Promise<unknown> | null = null;

  const tick = async () => {
    if (stopped || inFlight) {
      return;
    }
    if (pendingCount() === 0) {
      return;
    }
    inFlight = runOneFlushCycle(deps)
      .catch((err) => {
        deps.logger?.warn?.("autodex-sync flush cycle threw", {
          error: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        inFlight = null;
      });
  };

  const timer = setInterval(() => {
    void tick();
  }, intervalMs);
  // Unref so a stalled flush loop never blocks process exit.
  if (typeof timer.unref === "function") {
    timer.unref();
  }

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

function dropEmptyFields(event: AutodexIngestEvent): AutodexIngestEvent {
  const out: AutodexIngestEvent = {
    event_type: event.event_type,
    direction: event.direction,
  };
  if (event.status) {
    out.status = event.status;
  }
  if (event.dedupe_key) {
    out.dedupe_key = event.dedupe_key;
  }
  if (event.openclaw_turn_id) {
    out.openclaw_turn_id = event.openclaw_turn_id;
  }
  if (event.attempt_number !== undefined) {
    out.attempt_number = event.attempt_number;
  }
  if (event.thoughts_text) {
    out.thoughts_text = event.thoughts_text;
  }
  if (event.command_name) {
    out.command_name = event.command_name;
  }
  if (event.error_message) {
    out.error_message = event.error_message;
  }
  if (event.payload !== undefined) {
    out.payload = event.payload;
  }
  if (event.occurred_at) {
    out.occurred_at = event.occurred_at;
  }
  return out;
}

// Exposed for tests that need to act on the PendingEntry directly.
export type { PendingEntry };
