import type { EmbeddedRunTrigger } from "./params.js";

export function buildEmbeddedAttemptToolRunContext(params: {
  trigger?: EmbeddedRunTrigger;
  memoryFlushWritePath?: string;
  workContextId?: string;
}): {
  trigger?: EmbeddedRunTrigger;
  memoryFlushWritePath?: string;
  workContextId?: string;
} {
  return {
    trigger: params.trigger,
    memoryFlushWritePath: params.memoryFlushWritePath,
    workContextId: params.workContextId,
  };
}
