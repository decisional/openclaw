import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __testing,
  bindWorkContextToSession,
  buildCanonicalWorkContextSessionKey,
  resolveWorkContextBinding,
} from "./work-context-bindings.js";

describe("work-context bindings", () => {
  let previousStateDir: string | undefined;
  let testStateDir = "";

  beforeEach(async () => {
    previousStateDir = process.env.OPENCLAW_STATE_DIR;
    testStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-work-context-"));
    process.env.OPENCLAW_STATE_DIR = testStateDir;
    __testing.resetWorkContextBindingsForTests({ deletePersistedFile: true });
  });

  afterEach(async () => {
    __testing.resetWorkContextBindingsForTests({ deletePersistedFile: true });
    if (previousStateDir == null) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    await fs.rm(testStateDir, { recursive: true, force: true });
  });

  it("builds deterministic canonical session keys per scope and work context", () => {
    const first = buildCanonicalWorkContextSessionKey({
      agentId: "main",
      scopeKey: "compat:token:agent:main",
      workContextId: "ws_1:hitl:node_42",
    });
    const second = buildCanonicalWorkContextSessionKey({
      agentId: "main",
      scopeKey: "compat:token:agent:main",
      workContextId: "ws_1:hitl:node_42",
    });
    const otherScope = buildCanonicalWorkContextSessionKey({
      agentId: "main",
      scopeKey: "trusted-proxy:alice:agent:main",
      workContextId: "ws_1:hitl:node_42",
    });

    expect(first).toBe(second);
    expect(otherScope).not.toBe(first);
    expect(first).toContain("work-context:");
  });

  it("persists bindings and reloads them after the in-memory cache is cleared", async () => {
    const now = Date.now();
    bindWorkContextToSession({
      scopeKey: "compat:token:agent:main",
      workContextId: "ws_1:frontdesk:abc",
      sessionKey: "agent:main:work-context:1234",
      now,
    });
    await __testing.flushPersistForTests();
    __testing.resetWorkContextBindingsForTests();

    expect(
      resolveWorkContextBinding({
        scopeKey: "compat:token:agent:main",
        workContextId: "ws_1:frontdesk:abc",
        touch: false,
      }),
    ).toMatchObject({
      sessionKey: "agent:main:work-context:1234",
      boundAt: now,
    });
  });

  it("rebinds an existing work context to a new explicit session key", () => {
    const now = Date.now();
    bindWorkContextToSession({
      scopeKey: "compat:token:agent:main",
      workContextId: "ws_1:frontdesk:abc",
      sessionKey: "agent:main:work-context:1234",
      now,
    });

    const rebound = bindWorkContextToSession({
      scopeKey: "compat:token:agent:main",
      workContextId: "ws_1:frontdesk:abc",
      sessionKey: "agent:main:custom-session",
      now: now + 100,
    });

    expect(rebound).toMatchObject({
      sessionKey: "agent:main:custom-session",
      boundAt: now,
      lastResolvedAt: now + 100,
    });
  });

  it("expires stale bindings on lookup and persists the cleanup", async () => {
    const now = Date.now();
    bindWorkContextToSession({
      scopeKey: "compat:token:agent:main",
      workContextId: "ws_1:frontdesk:stale",
      sessionKey: "agent:main:work-context:stale",
      now,
    });

    expect(
      resolveWorkContextBinding({
        scopeKey: "compat:token:agent:main",
        workContextId: "ws_1:frontdesk:stale",
        now: now + __testing.limits.ttlMs + 1,
        touch: false,
      }),
    ).toBeNull();

    await __testing.flushPersistForTests();
    __testing.resetWorkContextBindingsForTests();

    expect(
      resolveWorkContextBinding({
        scopeKey: "compat:token:agent:main",
        workContextId: "ws_1:frontdesk:stale",
        touch: false,
      }),
    ).toBeNull();
  });

  it("evicts the oldest bindings when the store exceeds the max size", () => {
    const now = Date.now();
    for (let index = 0; index < __testing.limits.maxBindings + 1; index += 1) {
      bindWorkContextToSession({
        scopeKey: "compat:token:agent:main",
        workContextId: `ws_1:frontdesk:${index}`,
        sessionKey: `agent:main:work-context:${index}`,
        now: now + index,
      });
    }

    expect(__testing.listBindings()).toHaveLength(__testing.limits.maxBindings);
    expect(
      resolveWorkContextBinding({
        scopeKey: "compat:token:agent:main",
        workContextId: "ws_1:frontdesk:0",
        touch: false,
      }),
    ).toBeNull();
    expect(
      resolveWorkContextBinding({
        scopeKey: "compat:token:agent:main",
        workContextId: `ws_1:frontdesk:${__testing.limits.maxBindings}`,
        touch: false,
      }),
    ).toMatchObject({
      sessionKey: `agent:main:work-context:${__testing.limits.maxBindings}`,
    });
  });

  it("drops expired bindings before persisting newer ones to disk", async () => {
    const now = Date.now();
    bindWorkContextToSession({
      scopeKey: "compat:token:agent:main",
      workContextId: "ws_1:frontdesk:expired",
      sessionKey: "agent:main:work-context:expired",
      now: now - __testing.limits.ttlMs - 1,
    });
    bindWorkContextToSession({
      scopeKey: "compat:token:agent:main",
      workContextId: "ws_1:frontdesk:fresh",
      sessionKey: "agent:main:work-context:fresh",
      now,
    });

    await __testing.flushPersistForTests();
    __testing.resetWorkContextBindingsForTests();

    expect(
      resolveWorkContextBinding({
        scopeKey: "compat:token:agent:main",
        workContextId: "ws_1:frontdesk:expired",
        touch: false,
      }),
    ).toBeNull();
    expect(
      resolveWorkContextBinding({
        scopeKey: "compat:token:agent:main",
        workContextId: "ws_1:frontdesk:fresh",
        touch: false,
      }),
    ).toMatchObject({
      sessionKey: "agent:main:work-context:fresh",
    });
  });
});
