import type { AutodexSyncConfig } from "./client.js";
import { startAutodexSyncListener } from "./listener.js";
import { startAutodexSyncWorker } from "./worker.js";

export type StartAutodexSyncParams = {
  env?: NodeJS.ProcessEnv;
  intervalMs?: number;
  logger?: {
    info?: (msg: string, meta?: Record<string, unknown>) => void;
    warn?: (msg: string, meta?: Record<string, unknown>) => void;
    debug?: (msg: string, meta?: Record<string, unknown>) => void;
  };
};

export type AutodexSyncHandle = {
  stop: () => void;
  /** True when the sidecar is actually running (env-gated). */
  enabled: boolean;
};

/**
 * Boot the transcript-sync sidecar. Silent no-op when DECISIONAL_API_URL or
 * DECISIONAL_TOKEN are unset — this keeps self-hosted OpenClaw users
 * unaffected while Decisional-provisioned instances pick up the sync
 * automatically the moment their env is populated (during provisioning the
 * container already gets DECISIONAL_TOKEN wired).
 */
export function startAutodexSync(params: StartAutodexSyncParams = {}): AutodexSyncHandle {
  const env = params.env ?? process.env;
  const apiUrl = (env.DECISIONAL_API_URL ?? "").trim();
  const token = (env.DECISIONAL_TOKEN ?? "").trim();

  if (!apiUrl || !token) {
    params.logger?.info?.("autodex-sync disabled (DECISIONAL_API_URL / DECISIONAL_TOKEN unset)");
    return { stop: () => {}, enabled: false };
  }

  const cfg: AutodexSyncConfig = { apiUrl, token };
  const stopListener = startAutodexSyncListener({ logger: params.logger });
  const stopWorker = startAutodexSyncWorker({
    cfg,
    intervalMs: params.intervalMs,
    logger: params.logger,
  });

  params.logger?.info?.("autodex-sync enabled", { apiUrl });

  return {
    enabled: true,
    stop: () => {
      try {
        stopListener();
      } catch {
        // Best-effort shutdown — listener teardown errors shouldn't block worker stop.
      }
      try {
        stopWorker();
      } catch {
        // Same logic as above.
      }
    },
  };
}

export type { AutodexSyncConfig } from "./client.js";
export { resolveAutodexChannel } from "./channel.js";
export { shapeTranscriptEvent } from "./event-shape.js";
