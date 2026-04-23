import { createHash } from "node:crypto";
import { resolveAutodexChannel } from "./channel.js";
import type { AutodexEventDirection, AutodexIngestEvent, AutodexIngestSession } from "./types.js";

/**
 * Input bundle the listener passes to shapeTranscriptEvent. Mirrors the
 * SessionTranscriptUpdate emitted by sessions/transcript-events.ts but
 * widened to `unknown` for message because @mariozechner/pi-coding-agent
 * owns the message shape and we do not want to bind to its internals.
 */
export type TranscriptShapingInput = {
  sessionKey: string;
  messageId?: string;
  message?: unknown;
  occurredAt?: Date;
};

export type ShapedTranscriptEvent = {
  session: AutodexIngestSession;
  event: AutodexIngestEvent;
};

/**
 * Best-effort projection from a transcript message into an Autodex ingest
 * event. We never throw: any unrecognized shape still produces a
 * direction=internal event with the full message as payload so the server-side
 * timeline retains it.
 */
export function shapeTranscriptEvent(input: TranscriptShapingInput): ShapedTranscriptEvent {
  const sessionKey = input.sessionKey.trim();
  const rawMessage = isRecord(input.message) ? input.message : {};

  const role = stringField(rawMessage, "role");
  const messageType = stringField(rawMessage, "type");
  const eventType = resolveEventType(role, messageType, rawMessage);
  const direction = resolveDirection(role, messageType, eventType);
  const dedupeKey = input.messageId ?? fallbackDedupeKey(sessionKey, rawMessage);
  const externalThreadID = extractExternalThreadID(rawMessage, sessionKey);
  const externalChannelID = extractExternalChannelID(rawMessage);
  const externalUserID = extractExternalUserID(rawMessage);

  const session: AutodexIngestSession = {
    session_key: sessionKey,
    kind: "frontdesk_query",
    channel: resolveAutodexChannel(sessionKey),
    ...(externalChannelID ? { external_channel_id: externalChannelID } : {}),
    ...(externalThreadID ? { external_thread_id: externalThreadID } : {}),
    ...(externalUserID ? { external_user_id: externalUserID } : {}),
  };

  const event: AutodexIngestEvent = {
    event_type: eventType,
    direction,
    dedupe_key: dedupeKey,
    payload: rawMessage,
    ...(input.occurredAt ? { occurred_at: input.occurredAt.toISOString() } : {}),
  };

  const thoughts = stringField(rawMessage, "thoughts");
  if (thoughts) {
    event.thoughts_text = thoughts;
  }
  const error = stringField(rawMessage, "error");
  if (error) {
    event.error_message = error;
    event.status = "failed";
  }
  const turnId = stringField(rawMessage, "turnId") ?? stringField(rawMessage, "turn_id");
  if (turnId) {
    event.openclaw_turn_id = turnId;
  }
  const commandName =
    stringField(rawMessage, "commandName") ?? stringField(rawMessage, "command_name");
  if (commandName) {
    event.command_name = commandName;
  }

  return { session, event };
}

function resolveEventType(
  role: string | undefined,
  messageType: string | undefined,
  message: Record<string, unknown>,
): string {
  if (role === "user") {
    return "user_message";
  }
  if (role === "assistant") {
    return "assistant_message";
  }
  if (role === "system") {
    return "system_message";
  }
  if (role === "tool") {
    return "tool_result";
  }
  if (messageType === "tool_call" || isRecord(message.toolCall) || isRecord(message.tool_call)) {
    return "tool_call";
  }
  if (messageType === "tool_result") {
    return "tool_result";
  }
  if (messageType === "thought") {
    return "thought";
  }
  if (messageType === "plan" || messageType === "plan_update" || isRecord(message.plan)) {
    return "plan_update";
  }
  if (messageType === "error") {
    return "error";
  }
  return messageType || "message";
}

function resolveDirection(
  role: string | undefined,
  messageType: string | undefined,
  eventType: string,
): AutodexEventDirection {
  if (
    role === "user" ||
    role === "tool" ||
    eventType === "user_message" ||
    eventType === "tool_result" ||
    messageType === "tool_result"
  ) {
    return "inbound";
  }
  if (role === "assistant" || eventType === "assistant_message") {
    return "outbound";
  }
  return "internal";
}

function fallbackDedupeKey(sessionKey: string, message: Record<string, unknown>): string {
  // No messageId from the emitter and no explicit id on the message: hash the
  // canonical JSON so repeated identical deliveries still dedupe server-side.
  // Not collision-proof across the universe, only across a single session.
  const hash = createHash("sha256");
  hash.update(sessionKey);
  hash.update("\n");
  hash.update(safeStringify(message));
  return `autodex-sync/${hash.digest("hex").slice(0, 24)}`;
}

function extractExternalThreadID(
  message: Record<string, unknown>,
  sessionKey: string,
): string | undefined {
  const direct =
    stringField(message, "threadTs") ??
    stringField(message, "thread_ts") ??
    stringField(message, "threadId") ??
    stringField(message, "thread_id");
  if (direct) {
    return direct;
  }

  // Slack session keys can embed the thread timestamp as the last segment:
  // slack:thread:1699999999.012345
  const lowered = sessionKey.toLowerCase();
  if (lowered.startsWith("slack:thread:")) {
    const rest = sessionKey.slice("slack:thread:".length);
    const tail = rest.split(":").pop();
    if (tail && /^\d+\.\d+$/.test(tail)) {
      return tail;
    }
  }
  return undefined;
}

function extractExternalChannelID(message: Record<string, unknown>): string | undefined {
  return (
    stringField(message, "channelId") ??
    stringField(message, "channel_id") ??
    stringField(message, "channel")
  );
}

function extractExternalUserID(message: Record<string, unknown>): string | undefined {
  return (
    stringField(message, "userId") ??
    stringField(message, "user_id") ??
    stringField(message, "author") ??
    stringField(message, "from")
  );
}

function stringField(source: Record<string, unknown>, field: string): string | undefined {
  const value = source[field];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
