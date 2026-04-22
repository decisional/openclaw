import { describe, expect, it } from "vitest";
import { shapeTranscriptEvent } from "./event-shape.js";

describe("shapeTranscriptEvent", () => {
  it("maps user messages to inbound user_message with slack channel metadata", () => {
    const { session, event } = shapeTranscriptEvent({
      sessionKey: "slack:thread:1699999999.012345",
      messageId: "msg-1",
      message: {
        role: "user",
        text: "hello",
        channelId: "C0123ABC",
        userId: "U9",
      },
    });

    expect(session.channel).toBe("slack");
    expect(session.session_key).toBe("slack:thread:1699999999.012345");
    expect(session.kind).toBe("frontdesk_query");
    expect(session.external_thread_id).toBe("1699999999.012345");
    expect(session.external_channel_id).toBe("C0123ABC");
    expect(session.external_user_id).toBe("U9");

    expect(event.event_type).toBe("user_message");
    expect(event.direction).toBe("inbound");
    expect(event.dedupe_key).toBe("msg-1");
  });

  it("maps assistant messages to outbound assistant_message with thoughts", () => {
    const { event } = shapeTranscriptEvent({
      sessionKey: "agent:main:main",
      messageId: "msg-2",
      message: { role: "assistant", content: "hi", thoughts: "considering" },
    });

    expect(event.event_type).toBe("assistant_message");
    expect(event.direction).toBe("outbound");
    expect(event.thoughts_text).toBe("considering");
  });

  it("marks error messages as failed and forwards error_message", () => {
    const { event } = shapeTranscriptEvent({
      sessionKey: "agent:main:main",
      message: { type: "error", error: "boom" },
    });

    expect(event.event_type).toBe("error");
    expect(event.direction).toBe("internal");
    expect(event.status).toBe("failed");
    expect(event.error_message).toBe("boom");
  });

  it("detects tool_call and tool_result by type and payload shape", () => {
    const toolCall = shapeTranscriptEvent({
      sessionKey: "agent:main:main",
      message: { type: "tool_call", toolCall: { name: "run" } },
    });
    expect(toolCall.event.event_type).toBe("tool_call");

    const toolResult = shapeTranscriptEvent({
      sessionKey: "agent:main:main",
      message: { role: "tool", content: "42" },
    });
    expect(toolResult.event.event_type).toBe("tool_result");
    expect(toolResult.event.direction).toBe("inbound");
  });

  it("generates a stable dedupe_key when no messageId provided", () => {
    const a = shapeTranscriptEvent({
      sessionKey: "agent:main:main",
      message: { role: "assistant", content: "hi" },
    });
    const b = shapeTranscriptEvent({
      sessionKey: "agent:main:main",
      message: { role: "assistant", content: "hi" },
    });
    expect(a.event.dedupe_key).toBe(b.event.dedupe_key);
    expect(a.event.dedupe_key?.startsWith("autodex-sync/")).toBe(true);
  });

  it("passes through unknown message shapes as direction=internal", () => {
    const { event } = shapeTranscriptEvent({
      sessionKey: "agent:main:main",
      message: { strange: "shape" },
    });
    expect(event.event_type).toBe("message");
    expect(event.direction).toBe("internal");
    expect(event.payload).toEqual({ strange: "shape" });
  });
});
