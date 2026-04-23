import type { AutodexChannel } from "./types.js";

/**
 * Resolve the Autodex channel discriminator from an OpenClaw session key.
 *
 * Session keys are colon-separated and the surface marker can appear in any
 * segment, not just the first. Real keys we've seen in prod:
 *   agent:main:slack:channel:c07svgrmcby         → slack (Slack bot DM)
 *   slack:thread:1699999999.012345               → slack (legacy short form)
 *   agent:main:work-context:b890da235e9e...      → frontend (Autodex chat / chat_handler)
 *   agent:main:main                              → tui (local CLI)
 *
 * The resolver scans the full segment list:
 *   - any segment equal to "slack"        → slack
 *   - any segment equal to "work-context" → frontend
 *   - anything else                       → tui (local CLI is the only other
 *                                            surface that originates transcripts
 *                                            from inside OpenClaw itself)
 *
 * Empty/missing keys also fall to `tui` — the emitter sometimes fires on
 * file-rotation events before a key is bound; the listener already drops
 * those at the higher layer, but this keeps the helper total.
 */
export function resolveAutodexChannel(sessionKey: string | undefined | null): AutodexChannel {
  const trimmed = (sessionKey ?? "").trim().toLowerCase();
  if (!trimmed) {
    return "tui";
  }
  const segments = trimmed.split(":");
  if (segments.includes("slack")) {
    return "slack";
  }
  if (segments.includes("work-context")) {
    return "frontend";
  }
  return "tui";
}
