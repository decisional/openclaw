import { resolveBootstrapMode, type BootstrapMode } from "../../agents/bootstrap-mode.js";
import { appendCronStyleCurrentTimeLine } from "../../agents/current-time.js";
import { resolveEffectiveToolInventory } from "../../agents/tools-effective-inventory.js";
import { isWorkspaceBootstrapPending } from "../../agents/workspace.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

// Decisional fork: BOOTSTRAP.md is not part of our deployment model, and
// daily /new and /reset events at 04:00 kept re-anchoring agents on a
// bootstrap ritual that must not run here. The base reset prompt no longer
// references BOOTSTRAP.md, and the pending/limited variants are gone — reset
// always delivers the base prompt regardless of bootstrapMode.
const BARE_SESSION_RESET_PROMPT_BASE =
  "A new session was started via /new or /reset. Execute your Session Startup sequence now - read the required files before responding to the user. Then greet the user in your configured persona, if one is provided. Be yourself - use your defined voice, mannerisms, and mood. Keep it to 1-3 sentences and ask what they want to do. If the runtime model differs from default_model in the system prompt, mention the default model. Do not mention internal steps, files, tools, or reasoning.";

export function resolveBareResetBootstrapFileAccess(params: {
  cfg?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  workspaceDir?: string;
  modelProvider?: string;
  modelId?: string;
}): boolean {
  if (!params.cfg) {
    return false;
  }
  const inventory = resolveEffectiveToolInventory({
    cfg: params.cfg,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    workspaceDir: params.workspaceDir,
    modelProvider: params.modelProvider,
    modelId: params.modelId,
  });
  return inventory.groups.some((group) => group.tools.some((tool) => tool.id === "read"));
}

export async function resolveBareSessionResetPromptState(params: {
  cfg?: OpenClawConfig;
  workspaceDir?: string;
  nowMs?: number;
  isPrimaryRun?: boolean;
  isCanonicalWorkspace?: boolean;
  hasBootstrapFileAccess?: boolean | (() => boolean);
}): Promise<{
  bootstrapMode: BootstrapMode;
  prompt: string;
  shouldPrependStartupContext: boolean;
}> {
  const bootstrapPending = params.workspaceDir
    ? await isWorkspaceBootstrapPending(params.workspaceDir)
    : false;
  const hasBootstrapFileAccess = bootstrapPending
    ? typeof params.hasBootstrapFileAccess === "function"
      ? params.hasBootstrapFileAccess()
      : (params.hasBootstrapFileAccess ?? true)
    : true;
  const bootstrapMode = resolveBootstrapMode({
    bootstrapPending,
    runKind: "default",
    isInteractiveUserFacing: true,
    isPrimaryRun: params.isPrimaryRun ?? true,
    isCanonicalWorkspace: params.isCanonicalWorkspace ?? true,
    hasBootstrapFileAccess,
  });
  return {
    bootstrapMode,
    prompt: buildBareSessionResetPrompt(params.cfg, params.nowMs, bootstrapMode),
    shouldPrependStartupContext: bootstrapMode === "none",
  };
}

/**
 * Build the bare session reset prompt, appending the current date/time so agents
 * know which daily memory files to read during their Session Startup sequence.
 * Without this, agents on /new or /reset guess the date from their training cutoff.
 */
export function buildBareSessionResetPrompt(
  cfg?: OpenClawConfig,
  nowMs?: number,
  _bootstrapMode?: BootstrapMode,
): string {
  // _bootstrapMode is kept in the signature for API compatibility but no
  // longer influences the prompt: see top-of-file note.
  return appendCronStyleCurrentTimeLine(
    BARE_SESSION_RESET_PROMPT_BASE,
    cfg ?? {},
    nowMs ?? Date.now(),
  );
}

/** @deprecated Use buildBareSessionResetPrompt(cfg) instead */
export const BARE_SESSION_RESET_PROMPT = BARE_SESSION_RESET_PROMPT_BASE;
