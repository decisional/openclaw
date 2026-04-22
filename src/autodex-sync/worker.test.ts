import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { postIngest } from "./client.js";
import { __testing, enqueuePending, pendingCount } from "./store.js";
import { runOneFlushCycle } from "./worker.js";

let tempPath: string;

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autodex-sync-worker-"));
  tempPath = path.join(dir, "autodex-sync-pending.json");
  __testing.reset({ customPath: tempPath });
});

afterEach(async () => {
  await __testing.flushPersist();
  __testing.reset({ customPath: null });
  try {
    if (tempPath) {
      fs.rmSync(path.dirname(tempPath), { recursive: true, force: true });
    }
  } catch {
    // Best-effort cleanup.
  }
});

function mockFetch(
  responder: (url: string, init?: RequestInit) => Promise<Response> | Response,
): typeof fetch {
  return (async (input: unknown, init?: unknown) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    return responder(url, init as RequestInit | undefined);
  }) as typeof fetch;
}

describe("autodex-sync worker", () => {
  it("posts one request per session group and acks on success", async () => {
    enqueuePending({
      session: { session_key: "sess-a", kind: "frontdesk_query", channel: "tui" },
      event: { event_type: "user_message", direction: "inbound", dedupe_key: "a1" },
    });
    enqueuePending({
      session: { session_key: "sess-a", kind: "frontdesk_query", channel: "tui" },
      event: { event_type: "assistant_message", direction: "outbound", dedupe_key: "a2" },
    });
    enqueuePending({
      session: { session_key: "sess-b", kind: "frontdesk_query", channel: "slack" },
      event: { event_type: "user_message", direction: "inbound", dedupe_key: "b1" },
    });

    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchFn = mockFetch((url, init) => {
      const rawBody = typeof init?.body === "string" ? init.body : "{}";
      calls.push({ url, body: JSON.parse(rawBody) });
      return new Response(
        JSON.stringify({
          session_id: "00000000-0000-0000-0000-000000000001",
          created_session: true,
          events_received: 2,
          events_inserted: 2,
          events_deduplicated: 0,
        }),
        { status: 202, headers: { "Content-Type": "application/json" } },
      );
    });

    const summary = await runOneFlushCycle({
      cfg: { apiUrl: "http://autodex.test", token: "t" },
      fetchFn,
    });

    expect(summary.groupsAttempted).toBe(2);
    expect(summary.groupsSucceeded).toBe(2);
    expect(summary.entriesAcked).toBe(3);
    expect(summary.entriesRetried).toBe(0);
    expect(pendingCount()).toBe(0);
    expect(calls.length).toBe(2);
    expect(calls[0]?.url.endsWith("/v1/openclaw/events/ingest")).toBe(true);
  });

  it("retries with backoff on transient failures", async () => {
    enqueuePending({
      session: { session_key: "sess-a", kind: "frontdesk_query", channel: "tui" },
      event: { event_type: "user_message", direction: "inbound", dedupe_key: "a1" },
    });
    const fetchFn = mockFetch(() => new Response("oops", { status: 503 }));

    const summary = await runOneFlushCycle({
      cfg: { apiUrl: "http://autodex.test", token: "t" },
      fetchFn,
    });

    expect(summary.groupsSucceeded).toBe(0);
    expect(summary.entriesRetried).toBe(1);
    expect(pendingCount()).toBe(1);
  });

  it("drops permanent failures without queueing a retry", async () => {
    enqueuePending({
      session: { session_key: "sess-a", kind: "frontdesk_query", channel: "tui" },
      event: { event_type: "user_message", direction: "inbound", dedupe_key: "a1" },
    });
    const fetchFn = mockFetch(() => new Response("forbidden", { status: 403 }));

    const summary = await runOneFlushCycle({
      cfg: { apiUrl: "http://autodex.test", token: "t" },
      fetchFn,
    });

    expect(summary.groupsAttempted).toBe(1);
    expect(summary.groupsSucceeded).toBe(0);
    expect(summary.entriesAcked).toBe(1);
    expect(summary.entriesRetried).toBe(0);
    expect(pendingCount()).toBe(0);
  });
});

describe("postIngest", () => {
  it("reports network errors as retryable", async () => {
    const fetchFn = (() => Promise.reject(new Error("boom"))) as unknown as typeof fetch;
    const res = await postIngest(
      { apiUrl: "http://autodex.test", token: "t" },
      {
        session: { session_key: "s", kind: "frontdesk_query", channel: "tui" },
        events: [{ event_type: "user_message", direction: "inbound" }],
      },
      fetchFn,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.retryable).toBe(true);
    }
  });

  it("reports 429 as retryable but 401 as permanent", async () => {
    const fetch429 = mockFetch(() => new Response("", { status: 429 }));
    const fetch401 = mockFetch(() => new Response("", { status: 401 }));
    const req = {
      session: { session_key: "s", kind: "frontdesk_query" as const, channel: "tui" as const },
      events: [{ event_type: "user_message", direction: "inbound" as const }],
    };
    const a = await postIngest({ apiUrl: "http://x", token: "t" }, req, fetch429);
    const b = await postIngest({ apiUrl: "http://x", token: "t" }, req, fetch401);
    expect(a.ok).toBe(false);
    expect(b.ok).toBe(false);
    if (!a.ok) {
      expect(a.retryable).toBe(true);
    }
    if (!b.ok) {
      expect(b.retryable).toBe(false);
    }
  });
});

// Silence vitest unused-vi warning if we end up not mocking anything else.
void vi;
