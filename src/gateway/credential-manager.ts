import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { loadJsonFile } from "../infra/json-file.js";
import { writeJsonFileAtomically } from "../plugin-sdk/json-store.js";
import { DECISIONAL_TOKEN_ENV_KEY } from "../shared/hidden-env.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";

export type CredentialSlotRecord = {
  slotId: string;
  source: "baseline" | "scoped";
  token: string;
  createdAt: number;
  updatedAt: number;
  lastResolvedAt: number;
};

export type CredentialBindingRecord = {
  bindingId: string;
  bindingKind: "session_key" | "work_context_id";
  bindingKey: string;
  slotId: string;
  boundAt: number;
  lastResolvedAt: number;
};

type PersistedCredentialManagerFile = {
  version: 1;
  slots: CredentialSlotRecord[];
  bindings: CredentialBindingRecord[];
};

type DecisionalCredentialResolution = {
  slotId: string;
  token: string;
  bindingKind: CredentialBindingRecord["bindingKind"];
  bindingKey: string;
};

export type ScopedDecisionalHiddenEnvBindingStatus = "noop" | "bound" | "missing_work_context";

const FILE_VERSION = 1;
const BASELINE_SLOT_ID = "baseline_decisional";
const SESSION_BINDING_PREFIX = "credential-binding:session";
const WORK_CONTEXT_BINDING_PREFIX = "credential-binding:work-context";
const SCOPED_WORK_CONTEXT_SLOT_PREFIX = "scoped_decisional:work";
const SESSION_BINDING_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const WORK_CONTEXT_BINDING_TTL_MS = 24 * 60 * 60 * 1000;
const SCOPED_SLOT_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_SLOTS = 2_000;
const MAX_SESSION_BINDINGS = 5_000;
const MAX_WORK_CONTEXT_BINDINGS = 5_000;

const slotsById = new Map<string, CredentialSlotRecord>();
const sessionBindingsByKey = new Map<string, CredentialBindingRecord>();
const workContextBindingsByKey = new Map<string, CredentialBindingRecord>();
let loaded = false;
let persistPromise: Promise<void> = Promise.resolve();
let testPathOverride: string | null = null;

function normalizeValue(value: string | undefined | null): string {
  return normalizeOptionalString(value) ?? "";
}

function resolveManagerPath(env: NodeJS.ProcessEnv = process.env): string {
  if (testPathOverride) {
    return testPathOverride;
  }
  return path.join(resolveStateDir(env), "bindings", "credential-manager.json");
}

function buildStableId(prefix: string, value: string): string {
  const digest = createHash("sha256").update(value).digest("hex").slice(0, 24);
  return `${prefix}:${digest}`;
}

function buildSessionBindingId(sessionKey: string): string {
  return buildStableId(SESSION_BINDING_PREFIX, sessionKey);
}

function buildWorkContextBindingId(workContextId: string): string {
  return buildStableId(WORK_CONTEXT_BINDING_PREFIX, workContextId);
}

function buildScopedWorkContextSlotId(workContextId: string): string {
  return buildStableId(SCOPED_WORK_CONTEXT_SLOT_PREFIX, workContextId);
}

function getBindingTtlMs(kind: CredentialBindingRecord["bindingKind"]): number {
  return kind === "session_key" ? SESSION_BINDING_TTL_MS : WORK_CONTEXT_BINDING_TTL_MS;
}

function isBindingExpired(binding: CredentialBindingRecord, now: number): boolean {
  return now - binding.lastResolvedAt > getBindingTtlMs(binding.bindingKind);
}

function isSlotExpired(slot: CredentialSlotRecord, now: number): boolean {
  if (slot.slotId === BASELINE_SLOT_ID) {
    return false;
  }
  return now - slot.lastResolvedAt > SCOPED_SLOT_TTL_MS;
}

function touchSlot(slotId: string, now: number): CredentialSlotRecord | null {
  const slot = slotsById.get(slotId);
  if (!slot) {
    return null;
  }
  const updated = { ...slot, lastResolvedAt: now };
  slotsById.set(slotId, updated);
  return updated;
}

function touchBinding(
  map: Map<string, CredentialBindingRecord>,
  bindingKey: string,
  now: number,
): CredentialBindingRecord | null {
  const binding = map.get(bindingKey);
  if (!binding) {
    return null;
  }
  const updated = { ...binding, lastResolvedAt: now };
  map.delete(bindingKey);
  map.set(bindingKey, updated);
  return updated;
}

function upsertSlot(slot: CredentialSlotRecord): CredentialSlotRecord {
  slotsById.set(slot.slotId, slot);
  return slot;
}

function upsertBinding(
  map: Map<string, CredentialBindingRecord>,
  binding: CredentialBindingRecord,
): CredentialBindingRecord {
  map.delete(binding.bindingKey);
  map.set(binding.bindingKey, binding);
  return binding;
}

function toPersistedFile(): PersistedCredentialManagerFile {
  return {
    version: FILE_VERSION,
    slots: [...slotsById.values()].toSorted((a, b) => a.slotId.localeCompare(b.slotId)),
    bindings: [...sessionBindingsByKey.values(), ...workContextBindingsByKey.values()].toSorted(
      (a, b) => a.bindingId.localeCompare(b.bindingId),
    ),
  };
}

function pruneExpiredBindings(now: number): boolean {
  let removed = false;
  for (const [key, binding] of sessionBindingsByKey.entries()) {
    if (!isBindingExpired(binding, now)) {
      continue;
    }
    sessionBindingsByKey.delete(key);
    removed = true;
  }
  for (const [key, binding] of workContextBindingsByKey.entries()) {
    if (!isBindingExpired(binding, now)) {
      continue;
    }
    workContextBindingsByKey.delete(key);
    removed = true;
  }
  return removed;
}

function pruneExpiredSlots(now: number): boolean {
  let removed = false;
  for (const [slotId, slot] of slotsById.entries()) {
    if (!isSlotExpired(slot, now)) {
      continue;
    }
    const stillBound =
      [...sessionBindingsByKey.values()].some((binding) => binding.slotId === slotId) ||
      [...workContextBindingsByKey.values()].some((binding) => binding.slotId === slotId);
    if (stillBound) {
      continue;
    }
    slotsById.delete(slotId);
    removed = true;
  }
  return removed;
}

function evictOverflow(map: Map<string, CredentialBindingRecord>, maxSize: number): boolean {
  let removed = false;
  while (map.size > maxSize) {
    const oldestKey = map.keys().next().value;
    if (!oldestKey) {
      return removed;
    }
    map.delete(oldestKey);
    removed = true;
  }
  return removed;
}

function evictOverflowSlots(): boolean {
  let removed = false;
  while (slotsById.size > MAX_SLOTS) {
    const oldestEntry = [...slotsById.entries()].find(([slotId]) => slotId !== BASELINE_SLOT_ID);
    if (!oldestEntry) {
      return removed;
    }
    const [slotId] = oldestEntry;
    const stillBound =
      [...sessionBindingsByKey.values()].some((binding) => binding.slotId === slotId) ||
      [...workContextBindingsByKey.values()].some((binding) => binding.slotId === slotId);
    if (stillBound) {
      return removed;
    }
    slotsById.delete(slotId);
    removed = true;
  }
  return removed;
}

function compact(now: number): boolean {
  const removedBindings = pruneExpiredBindings(now);
  const removedSlots = pruneExpiredSlots(now);
  const evictedSessionBindings = evictOverflow(sessionBindingsByKey, MAX_SESSION_BINDINGS);
  const evictedWorkContextBindings = evictOverflow(
    workContextBindingsByKey,
    MAX_WORK_CONTEXT_BINDINGS,
  );
  const evictedSlots = evictOverflowSlots();
  return (
    removedBindings ||
    removedSlots ||
    evictedSessionBindings ||
    evictedWorkContextBindings ||
    evictedSlots
  );
}

function loadIntoMemory(): void {
  if (loaded) {
    return;
  }
  loaded = true;
  slotsById.clear();
  sessionBindingsByKey.clear();
  workContextBindingsByKey.clear();
  const parsed = loadJsonFile(resolveManagerPath()) as PersistedCredentialManagerFile | undefined;
  const now = Date.now();

  if (parsed?.version !== FILE_VERSION) {
    compact(now);
    return;
  }

  for (const rawSlot of parsed.slots ?? []) {
    const slotId = normalizeValue(rawSlot?.slotId);
    const token = normalizeValue(rawSlot?.token);
    const source = rawSlot?.source === "baseline" ? "baseline" : "scoped";
    if (!slotId || !token) {
      continue;
    }
    upsertSlot({
      slotId,
      token,
      source,
      createdAt:
        typeof rawSlot.createdAt === "number" && Number.isFinite(rawSlot.createdAt)
          ? rawSlot.createdAt
          : now,
      updatedAt:
        typeof rawSlot.updatedAt === "number" && Number.isFinite(rawSlot.updatedAt)
          ? rawSlot.updatedAt
          : now,
      lastResolvedAt:
        typeof rawSlot.lastResolvedAt === "number" && Number.isFinite(rawSlot.lastResolvedAt)
          ? rawSlot.lastResolvedAt
          : now,
    });
  }

  for (const rawBinding of parsed.bindings ?? []) {
    const bindingKind =
      rawBinding?.bindingKind === "session_key" ? "session_key" : "work_context_id";
    const bindingKey = normalizeValue(rawBinding?.bindingKey);
    const slotId = normalizeValue(rawBinding?.slotId);
    if (!bindingKey || !slotId || !slotsById.has(slotId)) {
      continue;
    }
    const binding: CredentialBindingRecord = {
      bindingId:
        normalizeValue(rawBinding.bindingId) ||
        (bindingKind === "session_key"
          ? buildSessionBindingId(bindingKey)
          : buildWorkContextBindingId(bindingKey)),
      bindingKind,
      bindingKey,
      slotId,
      boundAt:
        typeof rawBinding.boundAt === "number" && Number.isFinite(rawBinding.boundAt)
          ? rawBinding.boundAt
          : now,
      lastResolvedAt:
        typeof rawBinding.lastResolvedAt === "number" && Number.isFinite(rawBinding.lastResolvedAt)
          ? rawBinding.lastResolvedAt
          : now,
    };
    upsertBinding(
      bindingKind === "session_key" ? sessionBindingsByKey : workContextBindingsByKey,
      binding,
    );
  }

  compact(now);
}

async function persist(): Promise<void> {
  compact(Date.now());
  await writeJsonFileAtomically(resolveManagerPath(), toPersistedFile());
}

function enqueuePersist(): Promise<void> {
  persistPromise = persistPromise
    .catch(() => {})
    .then(async () => {
      await persist();
    });
  return persistPromise;
}

function resolveBindingMap(kind: CredentialBindingRecord["bindingKind"]) {
  return kind === "session_key" ? sessionBindingsByKey : workContextBindingsByKey;
}

function bindCredentialSlot(params: {
  bindingKind: CredentialBindingRecord["bindingKind"];
  bindingKey: string;
  slotId: string;
  now?: number;
}): CredentialBindingRecord | null {
  const bindingKey = normalizeValue(params.bindingKey);
  const slotId = normalizeValue(params.slotId);
  if (!bindingKey || !slotId || !slotsById.has(slotId)) {
    return null;
  }
  loadIntoMemory();
  const now = params.now ?? Date.now();
  const map = resolveBindingMap(params.bindingKind);
  const existing = map.get(bindingKey);
  const binding: CredentialBindingRecord = {
    bindingId:
      existing?.bindingId ??
      (params.bindingKind === "session_key"
        ? buildSessionBindingId(bindingKey)
        : buildWorkContextBindingId(bindingKey)),
    bindingKind: params.bindingKind,
    bindingKey,
    slotId,
    boundAt: existing?.boundAt ?? now,
    lastResolvedAt: now,
  };
  const inserted = upsertBinding(map, binding);
  compact(now);
  void enqueuePersist();
  return map.get(bindingKey) ?? inserted;
}

function resolveBoundSlot(params: {
  bindingKind: CredentialBindingRecord["bindingKind"];
  bindingKey: string | undefined;
  now: number;
}): DecisionalCredentialResolution | null {
  const bindingKey = normalizeValue(params.bindingKey ?? "");
  if (!bindingKey) {
    return null;
  }
  const map = resolveBindingMap(params.bindingKind);
  const binding = map.get(bindingKey);
  if (!binding) {
    return null;
  }
  if (isBindingExpired(binding, params.now)) {
    map.delete(bindingKey);
    void enqueuePersist();
    return null;
  }
  const slot = slotsById.get(binding.slotId);
  if (!slot) {
    map.delete(bindingKey);
    void enqueuePersist();
    return null;
  }
  if (isSlotExpired(slot, params.now)) {
    map.delete(bindingKey);
    slotsById.delete(slot.slotId);
    void enqueuePersist();
    return null;
  }

  const touchedBinding = touchBinding(map, bindingKey, params.now) ?? binding;
  const touchedSlot = touchSlot(slot.slotId, params.now) ?? slot;
  compact(params.now);
  void enqueuePersist();
  return {
    slotId: touchedSlot.slotId,
    token: touchedSlot.token,
    bindingKind: touchedBinding.bindingKind,
    bindingKey: touchedBinding.bindingKey,
  };
}

export function initializeGatewayCredentialManager(params?: {
  baselineToken?: string | undefined | null;
  now?: number;
}): void {
  loadIntoMemory();
  const baselineToken = normalizeValue(params?.baselineToken ?? "");
  if (!baselineToken) {
    return;
  }
  const now = params?.now ?? Date.now();
  const existing = slotsById.get(BASELINE_SLOT_ID);
  const next: CredentialSlotRecord = {
    slotId: BASELINE_SLOT_ID,
    source: "baseline",
    token: baselineToken,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    lastResolvedAt: existing?.lastResolvedAt ?? now,
  };
  upsertSlot(next);
  compact(now);
  void enqueuePersist();
}

export function ensureSessionBoundToBaselineDecisional(params: {
  sessionKey: string | undefined;
  now?: number;
}): CredentialBindingRecord | null {
  loadIntoMemory();
  const sessionKey = normalizeValue(params.sessionKey);
  if (!sessionKey || !slotsById.has(BASELINE_SLOT_ID)) {
    return null;
  }
  const existing = sessionBindingsByKey.get(sessionKey);
  if (existing) {
    return existing;
  }
  return bindCredentialSlot({
    bindingKind: "session_key",
    bindingKey: sessionKey,
    slotId: BASELINE_SLOT_ID,
    now: params.now,
  });
}

export function bindScopedDecisionalCredentialForWorkContext(params: {
  workContextId: string;
  token: string;
  now?: number;
}): CredentialBindingRecord | null {
  loadIntoMemory();
  const workContextId = normalizeValue(params.workContextId);
  const token = normalizeValue(params.token);
  if (!workContextId || !token) {
    return null;
  }
  const now = params.now ?? Date.now();
  const slotId = buildScopedWorkContextSlotId(workContextId);
  const existing = slotsById.get(slotId);
  upsertSlot({
    slotId,
    source: "scoped",
    token,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    lastResolvedAt: now,
  });
  return bindCredentialSlot({
    bindingKind: "work_context_id",
    bindingKey: workContextId,
    slotId,
    now,
  });
}

export function bindScopedDecisionalCredentialFromHiddenEnv(params: {
  workContextId?: string | undefined | null;
  hiddenEnv?: Record<string, string> | undefined;
  now?: number;
}): ScopedDecisionalHiddenEnvBindingStatus {
  const token = normalizeValue(params.hiddenEnv?.[DECISIONAL_TOKEN_ENV_KEY] ?? "");
  if (!token) {
    return "noop";
  }
  const workContextId = normalizeValue(params.workContextId ?? "");
  if (!workContextId) {
    return "missing_work_context";
  }
  bindScopedDecisionalCredentialForWorkContext({
    workContextId,
    token,
    now: params.now,
  });
  return "bound";
}

export function resolveDecisionalCredentialEnv(params: {
  sessionKey?: string | undefined;
  workContextId?: string | undefined;
  now?: number;
}): Record<string, string> | undefined {
  loadIntoMemory();
  const now = params.now ?? Date.now();
  const workContextId = normalizeValue(params.workContextId ?? "");
  if (workContextId) {
    const workContextResolution = resolveBoundSlot({
      bindingKind: "work_context_id",
      bindingKey: workContextId,
      now,
    });
    return workContextResolution
      ? { [DECISIONAL_TOKEN_ENV_KEY]: workContextResolution.token }
      : undefined;
  }
  const sessionResolution = resolveBoundSlot({
    bindingKind: "session_key",
    bindingKey: params.sessionKey,
    now,
  });
  if (!sessionResolution) {
    ensureSessionBoundToBaselineDecisional({
      sessionKey: params.sessionKey,
      now,
    });
  }
  const resolvedSession = sessionResolution
    ? sessionResolution
    : resolveBoundSlot({
        bindingKind: "session_key",
        bindingKey: params.sessionKey,
        now,
      });
  if (resolvedSession) {
    return { [DECISIONAL_TOKEN_ENV_KEY]: resolvedSession.token };
  }
  return undefined;
}

export const __testing = {
  flushPersistForTests: async (): Promise<void> => {
    await persistPromise;
  },
  reset(params?: { customPath?: string | null; deletePersistedFile?: boolean }) {
    slotsById.clear();
    sessionBindingsByKey.clear();
    workContextBindingsByKey.clear();
    loaded = false;
    persistPromise = Promise.resolve();
    testPathOverride = params?.customPath ?? null;
    if (params?.deletePersistedFile) {
      const targetPath = resolveManagerPath();
      try {
        fs.rmSync(targetPath, { force: true });
      } catch {
        // Best-effort test cleanup only.
      }
    }
  },
  listSlots(): CredentialSlotRecord[] {
    loadIntoMemory();
    return [...slotsById.values()].toSorted((a, b) => a.slotId.localeCompare(b.slotId));
  },
  listBindings(): CredentialBindingRecord[] {
    loadIntoMemory();
    return [...sessionBindingsByKey.values(), ...workContextBindingsByKey.values()].toSorted(
      (a, b) => a.bindingId.localeCompare(b.bindingId),
    );
  },
  constants: {
    baselineSlotId: BASELINE_SLOT_ID,
  },
};
