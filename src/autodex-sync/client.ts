import type { AutodexIngestRequest, AutodexIngestResponse } from "./types.js";

export type AutodexSyncConfig = {
  apiUrl: string;
  token: string;
  requestTimeoutMs?: number;
};

export type AutodexPostResult =
  | { ok: true; response: AutodexIngestResponse }
  | { ok: false; retryable: boolean; status?: number; error: string };

/**
 * Thin HTTP client for POST /v1/openclaw/events/ingest. Kept free of the
 * store / listener so unit tests can exercise it with a mock fetch and so the
 * backfill CLI can reuse it without going through the persisted queue.
 *
 * Retry policy lives in the worker, not here — all this does is classify the
 * response as `retryable` (5xx, network failures, 429) vs `permanent` (4xx
 * other than 429, because repeating them won't help) so the caller can
 * decide whether to re-enqueue or drop.
 */
export async function postIngest(
  cfg: AutodexSyncConfig,
  request: AutodexIngestRequest,
  fetchFn: typeof fetch = fetch,
): Promise<AutodexPostResult> {
  const url = joinUrl(cfg.apiUrl, "/v1/openclaw/events/ingest");
  const timeoutMs = cfg.requestTimeoutMs ?? 15_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchFn(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.token}`,
      },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
    const bodyText = await safeText(res);
    if (res.ok) {
      const parsed = safeJson(bodyText) as AutodexIngestResponse | null;
      if (!parsed) {
        return { ok: false, retryable: true, status: res.status, error: "malformed response body" };
      }
      return { ok: true, response: parsed };
    }
    // 401 / 403 are permanent (token revoked / instance unbound) — retrying
    // will just burn the backoff clock. 408 / 429 / 5xx are transient.
    const retryable = res.status === 408 || res.status === 429 || res.status >= 500;
    return {
      ok: false,
      retryable,
      status: res.status,
      error: truncate(bodyText, 400) || `http ${res.status}`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, retryable: true, error: message };
  } finally {
    clearTimeout(timer);
  }
}

function joinUrl(base: string, suffix: string): string {
  const trimmedBase = base.replace(/\/+$/, "");
  const trimmedSuffix = suffix.startsWith("/") ? suffix : `/${suffix}`;
  return `${trimmedBase}${trimmedSuffix}`;
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

function safeJson(text: string): unknown {
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function truncate(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max)}...`;
}
