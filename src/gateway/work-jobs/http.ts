import type { IncomingMessage, ServerResponse } from "node:http";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import type { AuthRateLimiter } from "../auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "../auth.js";
import { sendInvalidRequest, sendJson, sendMethodNotAllowed, sendText } from "../http-common.js";
import { handleGatewayPostJsonEndpoint } from "../http-endpoint-helpers.js";
import { authorizeGatewayHttpRequestOrReply } from "../http-utils.js";
import { ensureJob, getJobById, requeueFailed } from "./store.js";
import type { WorkJobRecord } from "./types.js";
import type { WorkJobWorker } from "./worker.js";

const WORK_PATH = "/v1/openclaw/work";
const WORK_PATH_PREFIX = `${WORK_PATH}/`;
const DEFAULT_MAX_BODY_BYTES = 1 * 1024 * 1024;

type WorkJobsHttpOptions = {
  auth: ResolvedGatewayAuth;
  worker: WorkJobWorker;
  trustedProxies?: string[];
  allowRealIpFallback?: boolean;
  rateLimiter?: AuthRateLimiter;
  maxBodyBytes?: number;
};

type PostRequestBody = {
  work_context_id?: unknown;
  system_prompt?: unknown;
  user_message?: unknown;
  message_channel?: unknown;
  model?: unknown;
  session_key?: unknown;
  retry_if_failed?: unknown;
};

function coerceString(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return normalizeOptionalString(value) ?? "";
}

function serializeJob(job: WorkJobRecord) {
  return {
    job_id: job.jobId,
    work_context_id: job.workContextId,
    state: job.state,
    attempts: job.attempts,
    created_at: job.createdAt,
    updated_at: job.updatedAt,
    started_at: job.startedAt,
    completed_at: job.completedAt,
    error: job.error,
    result: job.result,
  };
}

export function isWorkJobsPath(pathname: string): boolean {
  return pathname === WORK_PATH || pathname.startsWith(WORK_PATH_PREFIX);
}

export async function handleWorkJobsHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: WorkJobsHttpOptions,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host || "localhost"}`);
  if (!isWorkJobsPath(url.pathname)) {
    return false;
  }

  if (url.pathname === WORK_PATH) {
    return await handleCreate(req, res, opts);
  }

  const jobId = decodeURIComponent(url.pathname.slice(WORK_PATH_PREFIX.length));
  if (!jobId) {
    sendText(res, 404, "Not Found");
    return true;
  }

  return await handleGet(req, res, jobId, opts);
}

async function handleCreate(
  req: IncomingMessage,
  res: ServerResponse,
  opts: WorkJobsHttpOptions,
): Promise<boolean> {
  const handled = await handleGatewayPostJsonEndpoint(req, res, {
    pathname: WORK_PATH,
    auth: opts.auth,
    maxBodyBytes: opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
    trustedProxies: opts.trustedProxies,
    allowRealIpFallback: opts.allowRealIpFallback,
    rateLimiter: opts.rateLimiter,
    requiredOperatorMethod: "chat.send",
  });
  if (handled === false) {
    return false;
  }
  if (!handled) {
    return true;
  }

  const body = (handled.body ?? {}) as PostRequestBody;
  const workContextId = coerceString(body.work_context_id);
  const userMessage = coerceString(body.user_message);
  if (!workContextId) {
    sendInvalidRequest(res, "work_context_id is required");
    return true;
  }
  if (!userMessage) {
    sendInvalidRequest(res, "user_message is required");
    return true;
  }

  let job: WorkJobRecord;
  try {
    job = ensureJob({
      workContextId,
      inputs: {
        userMessage,
        systemPrompt: coerceString(body.system_prompt) || undefined,
        messageChannel: coerceString(body.message_channel) || undefined,
        model: coerceString(body.model) || undefined,
        sessionKey: coerceString(body.session_key) || undefined,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendInvalidRequest(res, message);
    return true;
  }

  const retryIfFailed = body.retry_if_failed === true;
  if (retryIfFailed && job.state === "failed") {
    const requeued = requeueFailed(workContextId);
    if (requeued) {
      job = requeued;
    }
  }

  opts.worker.notify();

  // Fresh accept (state=queued, attempts=0) → 202 Accepted so callers can tell the job was
  // newly created. Existing jobs (already queued/running/completed) → 200 OK.
  const statusCode = job.state === "queued" && job.attempts === 0 ? 202 : 200;
  res.setHeader("x-openclaw-work-context", job.workContextId);
  sendJson(res, statusCode, serializeJob(job));
  return true;
}

async function handleGet(
  req: IncomingMessage,
  res: ServerResponse,
  jobId: string,
  opts: WorkJobsHttpOptions,
): Promise<boolean> {
  if (req.method !== "GET" && req.method !== "HEAD") {
    sendMethodNotAllowed(res, "GET, HEAD");
    return true;
  }

  const requestAuth = await authorizeGatewayHttpRequestOrReply({
    req,
    res,
    auth: opts.auth,
    trustedProxies: opts.trustedProxies,
    allowRealIpFallback: opts.allowRealIpFallback,
    rateLimiter: opts.rateLimiter,
  });
  if (!requestAuth) {
    return true;
  }

  const job = getJobById(jobId);
  if (!job) {
    sendJson(res, 404, {
      error: { message: "job not found", type: "not_found" },
    });
    return true;
  }

  res.setHeader("x-openclaw-work-context", job.workContextId);
  sendJson(res, 200, serializeJob(job));
  return true;
}
