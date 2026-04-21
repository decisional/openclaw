import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __testing,
  bindScopedDecisionalCredentialForWorkContext,
  ensureSessionBoundToBaselineDecisional,
  initializeGatewayCredentialManager,
  resolveDecisionalCredentialEnv,
} from "./credential-manager.js";

let tempDir = "";

async function freshManager() {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-credential-manager-"));
  __testing.reset({
    customPath: path.join(tempDir, "credential-manager.json"),
    deletePersistedFile: true,
  });
}

beforeEach(async () => {
  await freshManager();
});

afterEach(async () => {
  await __testing.flushPersistForTests();
  __testing.reset({ customPath: null });
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

describe("credential-manager", () => {
  it("registers the baseline slot and resolves session bindings", () => {
    initializeGatewayCredentialManager({ baselineToken: "dex_full" });
    ensureSessionBoundToBaselineDecisional({ sessionKey: "slack:thread:1" });

    expect(resolveDecisionalCredentialEnv({ sessionKey: "slack:thread:1" })).toEqual({
      DECISIONAL_TOKEN: "dex_full",
    });
  });

  it("prefers work_context_id bindings over session_key baseline bindings", () => {
    initializeGatewayCredentialManager({ baselineToken: "dex_full" });
    ensureSessionBoundToBaselineDecisional({ sessionKey: "session:main" });
    bindScopedDecisionalCredentialForWorkContext({
      workContextId: "work:fixer:1",
      token: "dex_scoped",
    });

    expect(
      resolveDecisionalCredentialEnv({
        sessionKey: "session:main",
        workContextId: "work:fixer:1",
      }),
    ).toEqual({
      DECISIONAL_TOKEN: "dex_scoped",
    });
  });

  it("fails closed when a work_context_id is present but unbound", () => {
    initializeGatewayCredentialManager({ baselineToken: "dex_full" });
    ensureSessionBoundToBaselineDecisional({ sessionKey: "session:main" });

    expect(
      resolveDecisionalCredentialEnv({
        sessionKey: "session:main",
        workContextId: "work:missing",
      }),
    ).toBeUndefined();
  });

  it("persists scoped work-context bindings without storing tokens in the binding record", async () => {
    bindScopedDecisionalCredentialForWorkContext({
      workContextId: "work:fixer:2",
      token: "dex_scoped",
    });

    await __testing.flushPersistForTests();
    const customPath = path.join(tempDir, "credential-manager.json");
    __testing.reset({ customPath });

    expect(resolveDecisionalCredentialEnv({ workContextId: "work:fixer:2" })).toEqual({
      DECISIONAL_TOKEN: "dex_scoped",
    });
    expect(__testing.listBindings()).toEqual([
      expect.objectContaining({
        bindingKind: "work_context_id",
        bindingKey: "work:fixer:2",
        slotId: expect.not.stringContaining("dex_scoped"),
      }),
    ]);
  });

  it("returns no token when nothing is bound", () => {
    expect(resolveDecisionalCredentialEnv({ sessionKey: "slack:thread:missing" })).toBeUndefined();
  });
});
