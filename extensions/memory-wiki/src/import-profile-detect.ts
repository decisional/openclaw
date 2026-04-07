import fs from "node:fs/promises";
import path from "node:path";

function looksLikeChatGptConversationRecord(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const title = record.title;
  const mapping = record.mapping;
  return typeof title === "string" && !!mapping && typeof mapping === "object";
}

function looksLikeChatGptConversationsEnvelope(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const conversations = record.conversations;
  return (
    Array.isArray(conversations) &&
    conversations.some((entry) => looksLikeChatGptConversationRecord(entry))
  );
}

export function detectChatGptExportSample(params: { inputPath: string; sample: string }): boolean {
  const basename = path.basename(params.inputPath).toLowerCase();
  if (basename.includes("chatgpt")) {
    return true;
  }

  try {
    const parsed = JSON.parse(params.sample) as unknown;
    return (
      (Array.isArray(parsed) &&
        parsed.some((entry) => looksLikeChatGptConversationRecord(entry))) ||
      looksLikeChatGptConversationsEnvelope(parsed)
    );
  } catch {
    return false;
  }
}

export async function detectChatGptExportFile(inputPath: string): Promise<boolean> {
  const ext = path.extname(inputPath).toLowerCase();
  if (ext !== ".json") {
    return false;
  }
  const sample = await fs.readFile(inputPath, "utf8").catch(() => null);
  if (!sample) {
    return false;
  }
  return detectChatGptExportSample({ inputPath, sample });
}
