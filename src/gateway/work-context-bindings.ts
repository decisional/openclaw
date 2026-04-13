import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { loadJsonFile } from "../infra/json-file.js";
import { writeJsonFileAtomically } from "../plugin-sdk/json-store.js";
import { buildAgentMainSessionKey } from "../routing/session-key.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";

export type WorkContextBindingRecord = {
  bindingId: string;
  scopeKey: string;
  workContextId: string;
  sessionKey: string;
  boundAt: number;
  lastResolvedAt: number;
};

type PersistedWorkContextBindingsFile = {
  version: 1;
  bindings: WorkContextBindingRecord[];
};

const FILE_VERSION = 1;
const BINDING_ID_PREFIX = "work-context:";
const BINDING_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_BINDINGS = 1_000;
const bindingsByScopedKey = new Map<string, WorkContextBindingRecord>();
let bindingsLoaded = false;
let persistPromise: Promise<void> = Promise.resolve();

function normalizeValue(value: string | undefined | null): string {
  return normalizeOptionalString(value) ?? "";
}

function buildScopedKey(scopeKey: string, workContextId: string): string {
  return `${scopeKey}\u241f${workContextId}`;
}

function buildBindingId(scopeKey: string, workContextId: string): string {
  const digest = createHash("sha256")
    .update(buildScopedKey(scopeKey, workContextId))
    .digest("hex")
    .slice(0, 24);
  return `${BINDING_ID_PREFIX}${digest}`;
}

function resolveBindingsPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), "bindings", "work-context-sessions.json");
}

function toPersistedFile(): PersistedWorkContextBindingsFile {
  return {
    version: FILE_VERSION,
    bindings: [...bindingsByScopedKey.values()].toSorted((a, b) =>
      a.bindingId.localeCompare(b.bindingId),
    ),
  };
}

function isBindingExpired(binding: WorkContextBindingRecord, now: number): boolean {
  return now - binding.lastResolvedAt > BINDING_TTL_MS;
}

function upsertBindingRecord(
  key: string,
  record: WorkContextBindingRecord,
): WorkContextBindingRecord {
  bindingsByScopedKey.delete(key);
  bindingsByScopedKey.set(key, record);
  return record;
}

function pruneExpiredBindings(now: number): boolean {
  let removed = false;
  for (const [key, binding] of bindingsByScopedKey.entries()) {
    if (!isBindingExpired(binding, now)) {
      continue;
    }
    bindingsByScopedKey.delete(key);
    removed = true;
  }
  return removed;
}

function evictOverflowBindings(): boolean {
  let removed = false;
  while (bindingsByScopedKey.size > MAX_BINDINGS) {
    const oldestKey = bindingsByScopedKey.keys().next().value;
    if (!oldestKey) {
      return removed;
    }
    bindingsByScopedKey.delete(oldestKey);
    removed = true;
  }
  return removed;
}

function compactBindings(now: number): boolean {
  const pruned = pruneExpiredBindings(now);
  const evicted = evictOverflowBindings();
  return pruned || evicted;
}

function loadBindingsIntoMemory(): void {
  if (bindingsLoaded) {
    return;
  }
  bindingsLoaded = true;
  bindingsByScopedKey.clear();
  const parsed = loadJsonFile(resolveBindingsPath()) as
    | PersistedWorkContextBindingsFile
    | undefined;
  const bindings = parsed?.version === FILE_VERSION ? parsed.bindings : [];
  for (const binding of bindings ?? []) {
    const scopeKey = normalizeValue(binding?.scopeKey);
    const workContextId = normalizeValue(binding?.workContextId);
    const sessionKey = normalizeValue(binding?.sessionKey);
    if (!scopeKey || !workContextId || !sessionKey) {
      continue;
    }
    upsertBindingRecord(buildScopedKey(scopeKey, workContextId), {
      bindingId: normalizeValue(binding.bindingId) || buildBindingId(scopeKey, workContextId),
      scopeKey,
      workContextId,
      sessionKey,
      boundAt:
        typeof binding.boundAt === "number" && Number.isFinite(binding.boundAt)
          ? binding.boundAt
          : Date.now(),
      lastResolvedAt:
        typeof binding.lastResolvedAt === "number" && Number.isFinite(binding.lastResolvedAt)
          ? binding.lastResolvedAt
          : Date.now(),
    });
  }
  compactBindings(Date.now());
}

async function persistBindings(): Promise<void> {
  compactBindings(Date.now());
  await writeJsonFileAtomically(resolveBindingsPath(), toPersistedFile());
}

function enqueuePersist(): Promise<void> {
  persistPromise = persistPromise
    .catch(() => {})
    .then(async () => {
      await persistBindings();
    });
  return persistPromise;
}

export function buildCanonicalWorkContextSessionKey(params: {
  agentId: string;
  scopeKey: string;
  workContextId: string;
}): string {
  const digest = createHash("sha256")
    .update(buildScopedKey(params.scopeKey, params.workContextId))
    .digest("hex")
    .slice(0, 24);
  return buildAgentMainSessionKey({
    agentId: params.agentId,
    mainKey: `work-context:${digest}`,
  });
}

export function resolveWorkContextBinding(params: {
  scopeKey: string;
  workContextId: string;
  touch?: boolean;
  now?: number;
}): WorkContextBindingRecord | null {
  const scopeKey = normalizeValue(params.scopeKey);
  const workContextId = normalizeValue(params.workContextId);
  if (!scopeKey || !workContextId) {
    return null;
  }
  loadBindingsIntoMemory();
  const key = buildScopedKey(scopeKey, workContextId);
  const now = params.now ?? Date.now();
  const binding = bindingsByScopedKey.get(key) ?? null;
  if (!binding) {
    return null;
  }
  if (isBindingExpired(binding, now)) {
    bindingsByScopedKey.delete(key);
    void enqueuePersist();
    return null;
  }
  if (params.touch !== false) {
    const touchedBinding = upsertBindingRecord(key, {
      ...binding,
      lastResolvedAt: now,
    });
    compactBindings(now);
    void enqueuePersist();
    return bindingsByScopedKey.get(key) ?? touchedBinding;
  }
  return binding;
}

export function bindWorkContextToSession(params: {
  scopeKey: string;
  workContextId: string;
  sessionKey: string;
  now?: number;
}): WorkContextBindingRecord | null {
  const scopeKey = normalizeValue(params.scopeKey);
  const workContextId = normalizeValue(params.workContextId);
  const sessionKey = normalizeValue(params.sessionKey);
  if (!scopeKey || !workContextId || !sessionKey) {
    return null;
  }
  loadBindingsIntoMemory();
  const now = params.now ?? Date.now();
  const key = buildScopedKey(scopeKey, workContextId);
  const existing = bindingsByScopedKey.get(key);
  const record: WorkContextBindingRecord = {
    bindingId: existing?.bindingId ?? buildBindingId(scopeKey, workContextId),
    scopeKey,
    workContextId,
    sessionKey,
    boundAt: existing?.boundAt ?? now,
    lastResolvedAt: now,
  };
  const inserted = upsertBindingRecord(key, record);
  compactBindings(now);
  void enqueuePersist();
  return bindingsByScopedKey.get(key) ?? inserted;
}

export const __testing = {
  async flushPersistForTests(): Promise<void> {
    await persistPromise;
  },
  resetWorkContextBindingsForTests(params?: { deletePersistedFile?: boolean }) {
    bindingsByScopedKey.clear();
    bindingsLoaded = false;
    persistPromise = Promise.resolve();
    if (params?.deletePersistedFile) {
      try {
        fs.rmSync(resolveBindingsPath(), { force: true });
      } catch {
        // Best-effort cleanup for tests only.
      }
    }
  },
  listBindings(): WorkContextBindingRecord[] {
    loadBindingsIntoMemory();
    return [...bindingsByScopedKey.values()].toSorted((a, b) =>
      a.bindingId.localeCompare(b.bindingId),
    );
  },
  limits: {
    ttlMs: BINDING_TTL_MS,
    maxBindings: MAX_BINDINGS,
  },
};
