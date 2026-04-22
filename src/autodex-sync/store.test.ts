import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __testing, ackEntries, bumpRetry, claimDueGroups, enqueuePending } from "./store.js";

function makeSession(sessionKey = "agent:main:main") {
  return {
    session_key: sessionKey,
    kind: "frontdesk_query" as const,
    channel: "tui" as const,
  };
}

function makeEvent(dedupe = "e-1") {
  return {
    event_type: "assistant_message",
    direction: "outbound" as const,
    dedupe_key: dedupe,
    payload: { content: "hi" },
  };
}

let tempPath: string;

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autodex-sync-store-"));
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
    // Best-effort cleanup for test isolation.
  }
});

describe("autodex-sync store", () => {
  it("enqueues and returns grouped entries by session_key", async () => {
    enqueuePending({ session: makeSession("sess-a"), event: makeEvent("a1") });
    enqueuePending({ session: makeSession("sess-b"), event: makeEvent("b1") });
    enqueuePending({ session: makeSession("sess-a"), event: makeEvent("a2") });

    const groups = claimDueGroups({});
    expect([...groups.keys()].toSorted()).toEqual(["sess-a", "sess-b"]);
    expect(groups.get("sess-a")?.length).toBe(2);
    expect(groups.get("sess-b")?.length).toBe(1);
  });

  it("skips entries whose backoff has not elapsed", () => {
    const a = enqueuePending({ session: makeSession(), event: makeEvent("a1"), now: 1000 });
    bumpRetry([a.id], 1000);
    const due = claimDueGroups({ now: 1500 });
    expect(due.size).toBe(0);
    const later = claimDueGroups({ now: 5000 });
    expect(later.size).toBe(1);
  });

  it("acks remove entries from the queue", async () => {
    const a = enqueuePending({ session: makeSession(), event: makeEvent("a1") });
    ackEntries([a.id]);
    expect(__testing.list()).toHaveLength(0);
  });

  it("persists pending entries to disk", async () => {
    enqueuePending({ session: makeSession(), event: makeEvent("persist") });
    await __testing.flushPersist();
    const raw = JSON.parse(fs.readFileSync(tempPath, "utf-8"));
    expect(raw.version).toBe(1);
    expect(raw.entries).toHaveLength(1);
    expect(raw.entries[0].event.dedupe_key).toBe("persist");
  });
});
