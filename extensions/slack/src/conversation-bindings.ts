import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";

export function resolveSlackConversationBindingRef(params: {
  conversationId: string;
  parentConversationId?: string;
  threadId?: string | number | null;
}): { conversationId: string; parentConversationId?: string } | null {
  const conversationId = normalizeOptionalString(params.conversationId);
  if (!conversationId) {
    return null;
  }
  const parentConversationId = normalizeOptionalString(params.parentConversationId);
  const threadId =
    typeof params.threadId === "number"
      ? String(Math.trunc(params.threadId))
      : normalizeOptionalString(params.threadId?.toString());
  if (!threadId || threadId === conversationId) {
    return parentConversationId ? { conversationId, parentConversationId } : { conversationId };
  }
  return {
    conversationId: threadId,
    parentConversationId: conversationId,
  };
}
