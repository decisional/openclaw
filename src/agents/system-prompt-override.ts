import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveAgentConfig } from "./agent-scope.js";

function trimNonEmpty(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Resolves the configured system-prompt override (per-agent, falling back to
 * `agents.defaults.systemPromptOverride`) and, when an `extraSystemPrompt`
 * is provided alongside, appends it to the override separated by a blank
 * line so callers receive a single composed prompt.
 *
 * The composition step matters because callers use the return value in a
 * `??` fallback against `buildEmbeddedSystemPrompt({ extraSystemPrompt })`
 * (and equivalent CLI-runner builders). Without the merge, a configured
 * override silently wins over any per-request `extraSystemPrompt` — so
 * trusted callers that deliver specialized prompts per turn (e.g. Autodex's
 * fixer and approval accept-work payloads) would see their contract
 * evaporate the moment an operator set a default override for general chat.
 *
 * Returns undefined when no override is configured — preserves the
 * existing `??` fallback shape at call sites.
 */
export function resolveSystemPromptOverride(params: {
  config?: OpenClawConfig;
  agentId?: string;
  extraSystemPrompt?: string;
}): string | undefined {
  const config = params.config;
  if (!config) {
    return undefined;
  }
  const agentOverride = trimNonEmpty(
    params.agentId ? resolveAgentConfig(config, params.agentId)?.systemPromptOverride : undefined,
  );
  const override = agentOverride ?? trimNonEmpty(config.agents?.defaults?.systemPromptOverride);
  if (!override) {
    return undefined;
  }
  const extra = trimNonEmpty(params.extraSystemPrompt);
  return extra ? `${override}\n\n${extra}` : override;
}
