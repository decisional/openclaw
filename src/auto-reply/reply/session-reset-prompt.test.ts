import fs from "node:fs/promises";
import path from "node:path";
import { describe, it, expect } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { makeTempWorkspace } from "../../test-helpers/workspace.js";
import {
  buildBareSessionResetPrompt,
  resolveBareSessionResetPromptState,
} from "./session-reset-prompt.js";

describe("buildBareSessionResetPrompt", () => {
  // Decisional fork: the reset prompt never mentions BOOTSTRAP.md or
  // bootstrap-pending state, regardless of the bootstrapMode argument.
  it("includes the explicit Session Startup instruction for bare /new and /reset", () => {
    const prompt = buildBareSessionResetPrompt();
    expect(prompt).toContain("Execute your Session Startup sequence now");
    expect(prompt).toContain("read the required files before responding to the user");
    expect(prompt).toContain("Then greet the user in your configured persona");
    expect(prompt).not.toContain("BOOTSTRAP.md");
    expect(prompt).not.toContain("bootstrap is still pending");
  });

  it("never emits bootstrap-pending wording, even when bootstrapMode is full", () => {
    const prompt = buildBareSessionResetPrompt(undefined, undefined, "full");

    expect(prompt).not.toContain("BOOTSTRAP.md");
    expect(prompt).not.toContain("bootstrap is still pending");
    expect(prompt).toContain("Execute your Session Startup sequence now");
    expect(prompt).toContain("Then greet the user in your configured persona");
  });

  it("never emits limited bootstrap wording, even when bootstrapMode is limited", () => {
    const prompt = buildBareSessionResetPrompt(undefined, undefined, "limited");

    expect(prompt).not.toContain("BOOTSTRAP.md");
    expect(prompt).not.toContain("cannot safely complete");
    expect(prompt).not.toContain("Do not claim bootstrap is complete");
    expect(prompt).toContain("Execute your Session Startup sequence now");
  });

  it("appends current time line so agents know the date", () => {
    const cfg = {
      agents: { defaults: { userTimezone: "America/New_York", timeFormat: "12" } },
    } as OpenClawConfig;
    // 2026-03-03 14:00 UTC = 2026-03-03 09:00 EST
    const nowMs = Date.UTC(2026, 2, 3, 14, 0, 0);
    const prompt = buildBareSessionResetPrompt(cfg, nowMs);
    expect(prompt).toContain(
      "Current time: Tuesday, March 3rd, 2026 - 9:00 AM (America/New_York) / 2026-03-03 14:00 UTC",
    );
  });

  it("does not append a duplicate current time line", () => {
    const nowMs = Date.UTC(2026, 2, 3, 14, 0, 0);
    const prompt = buildBareSessionResetPrompt(undefined, nowMs);
    expect((prompt.match(/Current time:/g) ?? []).length).toBe(1);
  });

  it("falls back to UTC when no timezone configured", () => {
    const nowMs = Date.UTC(2026, 2, 3, 14, 0, 0);
    const prompt = buildBareSessionResetPrompt(undefined, nowMs);
    expect(prompt).toContain("Current time:");
  });

  it("resolves shared bare reset prompt state from workspace bootstrap truth", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-reset-bootstrap-");
    await fs.writeFile(path.join(workspaceDir, "BOOTSTRAP.md"), "ritual", "utf8");

    // bootstrapMode still reflects workspace truth (file exists → "full") so
    // callers that care about the flag keep working; the emitted prompt,
    // however, no longer differs — fork strips all bootstrap wording.
    const pending = await resolveBareSessionResetPromptState({ workspaceDir });
    expect(pending.bootstrapMode).toBe("full");
    expect(pending.shouldPrependStartupContext).toBe(false);
    expect(pending.prompt).not.toContain("BOOTSTRAP.md");
    expect(pending.prompt).not.toContain("bootstrap is still pending");
    expect(pending.prompt).toContain("Execute your Session Startup sequence now");

    await fs.unlink(path.join(workspaceDir, "BOOTSTRAP.md"));

    const complete = await resolveBareSessionResetPromptState({ workspaceDir });
    expect(complete.bootstrapMode).toBe("none");
    expect(complete.shouldPrependStartupContext).toBe(true);
    expect(complete.prompt).toContain("Execute your Session Startup sequence now");
  });

  it("does not resolve bootstrap file access when bootstrap is complete", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-reset-bootstrap-complete-");
    let resolvedAccess = false;

    const complete = await resolveBareSessionResetPromptState({
      workspaceDir,
      hasBootstrapFileAccess: () => {
        resolvedAccess = true;
        return false;
      },
    });

    expect(complete.bootstrapMode).toBe("none");
    expect(complete.shouldPrependStartupContext).toBe(true);
    expect(resolvedAccess).toBe(false);
  });

  it("suppresses bootstrap mode for non-primary bare reset sessions", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-reset-non-primary-");
    await fs.writeFile(path.join(workspaceDir, "BOOTSTRAP.md"), "ritual", "utf8");

    const pending = await resolveBareSessionResetPromptState({
      workspaceDir,
      isPrimaryRun: false,
    });

    expect(pending.bootstrapMode).toBe("none");
    expect(pending.shouldPrependStartupContext).toBe(true);
    expect(pending.prompt).toContain("Execute your Session Startup sequence now");
    expect(pending.prompt).not.toContain("while bootstrap is still pending for this workspace");
  });

  it("suppresses bootstrap mode when bare reset has no bootstrap file access", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-reset-no-file-access-");
    await fs.writeFile(path.join(workspaceDir, "BOOTSTRAP.md"), "ritual", "utf8");

    const pending = await resolveBareSessionResetPromptState({
      workspaceDir,
      hasBootstrapFileAccess: false,
    });

    expect(pending.bootstrapMode).toBe("none");
    expect(pending.shouldPrependStartupContext).toBe(true);
    expect(pending.prompt).toContain("Execute your Session Startup sequence now");
    expect(pending.prompt).not.toContain("while bootstrap is still pending for this workspace");
  });
});
