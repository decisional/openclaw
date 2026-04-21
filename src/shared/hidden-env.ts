import { normalizeOptionalString } from "./string-coerce.js";

export const DECISIONAL_TOKEN_ENV_KEY = "DECISIONAL_TOKEN";

const ALLOWED_HIDDEN_ENV_KEYS = new Set([DECISIONAL_TOKEN_ENV_KEY]);

function normalizeHiddenEnvKey(value: unknown): string {
  return normalizeOptionalString(typeof value === "string" ? value : "") ?? "";
}

export function coerceAllowedHiddenEnv(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const entries = Object.entries(value)
    .map(([key, entry]) => [normalizeHiddenEnvKey(key), normalizeOptionalString(entry)] as const)
    .filter(
      ([key, entry]) => !!key && !!entry && ALLOWED_HIDDEN_ENV_KEYS.has(key),
    )
    .map(([key, entry]) => [key, entry!] as const);

  if (entries.length === 0) {
    return undefined;
  }
  return Object.fromEntries(entries);
}

export function findDisallowedHiddenEnvKeys(hiddenEnv: Record<string, string>): string[] {
  return Object.keys(hiddenEnv)
    .map((key) => normalizeHiddenEnvKey(key))
    .filter((key) => !!key && !ALLOWED_HIDDEN_ENV_KEYS.has(key));
}

export function getAllowedHiddenEnvKeys(): string[] {
  return [...ALLOWED_HIDDEN_ENV_KEYS];
}
