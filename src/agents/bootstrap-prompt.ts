// Decisional fork: bootstrap prompt injection is disabled. OpenClaw workspaces
// in our deployment are pre-provisioned by autodex (config, auth, AGENTS.md);
// the upstream BOOTSTRAP.md onboarding ritual is neither needed nor runnable
// in chat-only contexts, and the per-turn/per-reset prefix was blocking agents
// from replying normally. These helpers now return no prompt lines so nothing
// bootstrap-related ever reaches the model. Callers still compile and the
// public signatures are preserved for cross-package safety.
export function buildFullBootstrapPromptLines(_params: {
  readLine: string;
  firstReplyLine: string;
}): string[] {
  return [];
}

export function buildLimitedBootstrapPromptLines(_params: {
  introLine: string;
  nextStepLine: string;
}): string[] {
  return [];
}
