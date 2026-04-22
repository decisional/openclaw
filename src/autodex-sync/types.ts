/**
 * Autodex ingest payload shapes. Mirrors the server-side dto/openclaw_ingest_dto.go.
 * Kept in a separate file so the client, worker, store, and backfill all agree on
 * the wire format without circular imports.
 */

export type AutodexChannel = "slack" | "tui" | "frontend" | "api";

// The server enum covers four kinds; OpenClaw only originates frontdesk_query
// for direct chat. HITL / run_fixer sessions are created by Autodex via its
// dispatch queue and already have rows in openclaw_sessions — we still append
// events to them (the service's FindOrCreate is idempotent by session_key),
// but the kind we declare on a sync call is always the direct-chat one.
export type AutodexSessionKind = "frontdesk_query" | "hitl_approval" | "run_fixer" | "adhoc_ops";

export type AutodexEventDirection = "inbound" | "outbound" | "internal";
export type AutodexEventStatus = "info" | "started" | "completed" | "failed";

export type AutodexIngestSession = {
  session_key: string;
  kind: AutodexSessionKind;
  channel: AutodexChannel;
  external_channel_id?: string;
  external_thread_id?: string;
  external_user_id?: string;
  metadata?: Record<string, unknown>;
};

export type AutodexIngestEvent = {
  event_type: string;
  direction: AutodexEventDirection;
  status?: AutodexEventStatus;
  dedupe_key?: string;
  openclaw_turn_id?: string;
  attempt_number?: number;
  thoughts_text?: string;
  command_name?: string;
  error_message?: string;
  payload?: Record<string, unknown>;
  occurred_at?: string;
};

export type AutodexIngestRequest = {
  session: AutodexIngestSession;
  events: AutodexIngestEvent[];
};

export type AutodexIngestResponse = {
  session_id: string;
  created_session: boolean;
  events_received: number;
  events_inserted: number;
  events_deduplicated: number;
};

/**
 * One queued pending entry. The session identity rides on each entry rather
 * than being stored once per session so the worker can group freely by
 * session_key at flush time and we don't have to maintain a second index.
 */
export type PendingEntry = {
  id: string;
  enqueuedAt: number;
  attempts: number;
  nextAttemptAt: number;
  session: AutodexIngestSession;
  event: AutodexIngestEvent;
};
