import type { AutodexChannel } from "./types.js";

/**
 * Resolve the Autodex channel discriminator from an OpenClaw session key.
 *
 * OpenClaw session keys carry the surface in the first colon-segment:
 *   slack:C0123ABC           → slack
 *   slack:channel:C0123ABC   → slack
 *   slack:thread:1699..      → slack
 * anything without a known prefix defaults to "tui", which is the only other
 * surface that originates transcripts from inside OpenClaw (direct local chat
 * via the terminal UI). Autodex-originated sessions (frontend / api) never
 * flow in this direction; the dispatch queue owns them the other way round.
 */
export function resolveAutodexChannel(sessionKey: string | undefined | null): AutodexChannel {
  const trimmed = (sessionKey ?? "").trim().toLowerCase();
  if (!trimmed) {
    return "tui";
  }
  const firstSegment = trimmed.split(":", 1)[0];
  if (firstSegment === "slack") {
    return "slack";
  }
  return "tui";
}
