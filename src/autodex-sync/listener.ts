import { onSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import { shapeTranscriptEvent } from "./event-shape.js";
import { enqueuePending } from "./store.js";

/**
 * Wire the transcript tap into the persisted ingest queue. Returns an
 * unsubscribe function; call it during shutdown or in tests. Updates that
 * lack both a session_key and a message payload are dropped — the emitter
 * occasionally fires on file-rotation events that carry no transcript data.
 */
export function startAutodexSyncListener(params?: {
  logger?: { warn?: (msg: string, meta?: Record<string, unknown>) => void };
}): () => void {
  const unsubscribe = onSessionTranscriptUpdate((update) => {
    try {
      const sessionKey = update.sessionKey?.trim();
      if (!sessionKey) {
        return;
      }
      if (update.message === undefined) {
        return;
      }

      const shaped = shapeTranscriptEvent({
        sessionKey,
        messageId: update.messageId,
        message: update.message,
      });
      enqueuePending({ session: shaped.session, event: shaped.event });
    } catch (err) {
      params?.logger?.warn?.("autodex-sync listener failed on transcript update", {
        error: err instanceof Error ? err.message : String(err),
        sessionKey: update.sessionKey,
      });
    }
  });
  return unsubscribe;
}
