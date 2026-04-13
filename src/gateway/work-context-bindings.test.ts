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
    bindWorkContextToSession({
      scopeKey: "compat:token:agent:main",
      workContextId: "ws_1:frontdesk:abc",
      sessionKey: "agent:main:work-context:1234",
      now: 100,
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
      boundAt: 100,
    });
  });

  it("rebinds an existing work context to a new explicit session key", () => {
    bindWorkContextToSession({
      scopeKey: "compat:token:agent:main",
      workContextId: "ws_1:frontdesk:abc",
      sessionKey: "agent:main:work-context:1234",
      now: 100,
    });

    const rebound = bindWorkContextToSession({
      scopeKey: "compat:token:agent:main",
      workContextId: "ws_1:frontdesk:abc",
      sessionKey: "agent:main:custom-session",
      now: 200,
    });

    expect(rebound).toMatchObject({
      sessionKey: "agent:main:custom-session",
      boundAt: 100,
      lastResolvedAt: 200,
    });
  });
});
