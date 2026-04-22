import { describe, expect, it } from "vitest";
import { resolveSystemPromptOverride } from "./system-prompt-override.js";

describe("resolveSystemPromptOverride", () => {
  it("uses defaults when no per-agent override exists", () => {
    expect(
      resolveSystemPromptOverride({
        config: {
          agents: {
            defaults: { systemPromptOverride: "  default system  " },
            list: [{ id: "main" }],
          },
        },
        agentId: "main",
      }),
    ).toBe("default system");
  });

  it("prefers the per-agent override", () => {
    expect(
      resolveSystemPromptOverride({
        config: {
          agents: {
            defaults: { systemPromptOverride: "default system" },
            list: [{ id: "main", systemPromptOverride: "  agent system  " }],
          },
        },
        agentId: "main",
      }),
    ).toBe("agent system");
  });

  it("ignores blank override values", () => {
    expect(
      resolveSystemPromptOverride({
        config: {
          agents: {
            defaults: { systemPromptOverride: "default system" },
            list: [{ id: "main", systemPromptOverride: "   " }],
          },
        },
        agentId: "main",
      }),
    ).toBe("default system");
  });

  // Per-request extraSystemPrompt (e.g. Autodex's fixer / approval
  // accept-work payloads) must be preserved when a config-level override
  // exists, otherwise trusted callers lose the prompt contract they
  // rely on the moment an operator sets any default override.
  it("appends extraSystemPrompt to the resolved override", () => {
    expect(
      resolveSystemPromptOverride({
        config: {
          agents: {
            defaults: { systemPromptOverride: "default system" },
            list: [{ id: "main" }],
          },
        },
        agentId: "main",
        extraSystemPrompt: "per-request extras",
      }),
    ).toBe("default system\n\nper-request extras");
  });

  it("appends extraSystemPrompt to a per-agent override", () => {
    expect(
      resolveSystemPromptOverride({
        config: {
          agents: {
            defaults: { systemPromptOverride: "default system" },
            list: [{ id: "main", systemPromptOverride: "agent system" }],
          },
        },
        agentId: "main",
        extraSystemPrompt: "  per-request extras  ",
      }),
    ).toBe("agent system\n\nper-request extras");
  });

  it("ignores blank extraSystemPrompt values", () => {
    expect(
      resolveSystemPromptOverride({
        config: {
          agents: {
            defaults: { systemPromptOverride: "default system" },
            list: [{ id: "main" }],
          },
        },
        agentId: "main",
        extraSystemPrompt: "   ",
      }),
    ).toBe("default system");
  });

  it("returns undefined so callers fall back to stock prompt when no override is configured, even with extras", () => {
    // Call sites use `resolveSystemPromptOverride(...) ?? buildStockPrompt(...)` —
    // extras alone without a configured override must NOT short-circuit the
    // fallback, otherwise stock-prompt framing (tool docs, runtime info,
    // sandbox context) is lost when only the per-request extras are provided.
    expect(
      resolveSystemPromptOverride({
        config: { agents: { defaults: {}, list: [{ id: "main" }] } },
        agentId: "main",
        extraSystemPrompt: "per-request extras",
      }),
    ).toBeUndefined();
  });
});
