import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { resolveStateDir } from "../config/paths.js";
import { postIngest, type AutodexSyncConfig } from "./client.js";
import { shapeTranscriptEvent, type TranscriptShapingInput } from "./event-shape.js";
import type { AutodexIngestEvent, AutodexIngestRequest, AutodexIngestSession } from "./types.js";

/**
 * One-shot replay of existing session JSONL files into Autodex. Intended for
 * hosts that already accumulated transcripts before the live sync landed —
 * or for forcing a re-ingest after a server-side schema change. Idempotent
 * because ingest dedupes on (session_id, dedupe_key).
 *
 * Layout assumption matches resolveStateDir's:
 *   <stateDir>/agents/<agentId>/sessions/*.jsonl
 * Files are streamed line-by-line so a huge transcript doesn't blow RAM.
 */
export type BackfillParams = {
  cfg: AutodexSyncConfig;
  env?: NodeJS.ProcessEnv;
  rootDir?: string;
  batchSize?: number;
  fetchFn?: typeof fetch;
  logger?: {
    info?: (msg: string, meta?: Record<string, unknown>) => void;
    warn?: (msg: string, meta?: Record<string, unknown>) => void;
  };
};

export type BackfillResult = {
  filesProcessed: number;
  eventsSent: number;
  eventsInserted: number;
  eventsDeduplicated: number;
  failures: Array<{ file: string; error: string }>;
};

export async function backfillAutodexSync(params: BackfillParams): Promise<BackfillResult> {
  const env = params.env ?? process.env;
  const rootDir = params.rootDir ?? path.join(resolveStateDir(env), "agents");
  const batchSize = params.batchSize ?? 200;

  const result: BackfillResult = {
    filesProcessed: 0,
    eventsSent: 0,
    eventsInserted: 0,
    eventsDeduplicated: 0,
    failures: [],
  };

  const files = await collectSessionFiles(rootDir);
  for (const file of files) {
    try {
      const { sent, inserted, deduplicated } = await backfillSingleFile({
        file,
        cfg: params.cfg,
        batchSize,
        fetchFn: params.fetchFn,
        logger: params.logger,
      });
      result.filesProcessed += 1;
      result.eventsSent += sent;
      result.eventsInserted += inserted;
      result.eventsDeduplicated += deduplicated;
    } catch (err) {
      result.failures.push({ file, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}

async function backfillSingleFile(params: {
  file: string;
  cfg: AutodexSyncConfig;
  batchSize: number;
  fetchFn?: typeof fetch;
  logger?: BackfillParams["logger"];
}): Promise<{ sent: number; inserted: number; deduplicated: number }> {
  let header: { id?: string; sessionKey?: string } | undefined;
  let session: AutodexIngestSession | undefined;
  let pendingBatch: AutodexIngestEvent[] = [];
  let sent = 0;
  let inserted = 0;
  let deduplicated = 0;

  const stream = fs.createReadStream(params.file, { encoding: "utf-8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  const flush = async () => {
    if (!session || pendingBatch.length === 0) {
      return;
    }
    const request: AutodexIngestRequest = { session, events: pendingBatch };
    sent += pendingBatch.length;
    const res = await postIngest(params.cfg, request, params.fetchFn);
    if (res.ok) {
      inserted += res.response.events_inserted;
      deduplicated += res.response.events_deduplicated;
    } else {
      params.logger?.warn?.(`backfill flush failed for ${params.file}`, {
        status: res.status,
        error: res.error,
      });
    }
    pendingBatch = [];
  };

  for await (const rawLine of rl) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) {
      continue;
    }
    if (parsed.type === "session") {
      header = { id: stringOrUndef(parsed.id), sessionKey: stringOrUndef(parsed.sessionKey) };
      continue;
    }

    const sessionKey =
      stringOrUndef(parsed.sessionKey) ??
      header?.sessionKey ??
      deriveSessionKeyFromPath(params.file);
    if (!sessionKey) {
      continue;
    }
    const shaping: TranscriptShapingInput = {
      sessionKey,
      message: parsed,
      messageId: stringOrUndef(parsed.id) ?? stringOrUndef(parsed.messageId),
      occurredAt: extractOccurredAt(parsed),
    };
    const shaped = shapeTranscriptEvent(shaping);
    if (!session) {
      session = shaped.session;
    }
    pendingBatch.push(shaped.event);
    if (pendingBatch.length >= params.batchSize) {
      await flush();
    }
  }
  await flush();
  return { sent, inserted, deduplicated };
}

async function collectSessionFiles(rootDir: string): Promise<string[]> {
  if (!fs.existsSync(rootDir)) {
    return [];
  }
  const out: string[] = [];
  const stack: string[] = [rootDir];
  while (stack.length) {
    const current = stack.pop()!;
    let entries: fs.Dirent[] = [];
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        out.push(full);
      }
    }
  }
  return out;
}

function deriveSessionKeyFromPath(filePath: string): string | undefined {
  // Fall back to the file stem when the JSONL header didn't carry a session
  // key. The server-side upsert keys on (workspace_id, session_key) so this
  // will produce a stable, per-file session row.
  const base = path.basename(filePath, ".jsonl");
  return base || undefined;
}

function extractOccurredAt(message: Record<string, unknown>): Date | undefined {
  const raw =
    stringOrUndef(message.timestamp) ??
    stringOrUndef(message.createdAt) ??
    stringOrUndef(message.created_at);
  if (!raw) {
    return undefined;
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    return undefined;
  }
  return parsed;
}

function stringOrUndef(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// CLI entry: `node dist/autodex-sync/backfill.js` when the build output lands
// there. Kept self-contained (no Commander registration) so it stays out of
// the main CLI surface; Decisional operators run it ad-hoc during rollout.
if (import.meta.url === `file://${process.argv[1]}`) {
  const apiUrl = (process.env.DECISIONAL_API_URL ?? "").trim();
  const token = (process.env.DECISIONAL_TOKEN ?? "").trim();
  if (!apiUrl || !token) {
    // eslint-disable-next-line no-console
    console.error("backfill requires DECISIONAL_API_URL and DECISIONAL_TOKEN");
    process.exit(1);
  }
  backfillAutodexSync({ cfg: { apiUrl, token } })
    .then((result) => {
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(result, null, 2));
      if (result.failures.length > 0) {
        process.exit(1);
      }
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error(err);
      process.exit(1);
    });
}
