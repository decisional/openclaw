import { formatInboundEnvelope } from "openclaw/plugin-sdk/channel-inbound";
import type { ContextVisibilityMode } from "openclaw/plugin-sdk/config-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import {
  filterSupplementalContextItems,
  shouldIncludeSupplementalContext,
} from "openclaw/plugin-sdk/security-runtime";
import type { ResolvedSlackAccount } from "../../accounts.js";
import type { SlackMessageEvent } from "../../types.js";
import { resolveSlackAllowListMatch } from "../allow-list.js";
import { readSessionUpdatedAt } from "../config.runtime.js";
import type { SlackMonitorContext } from "../context.js";
import {
  resolveSlackMedia,
  resolveSlackThreadHistory,
  type SlackMediaResult,
  type SlackThreadStarter,
} from "../media.js";

// Upstream OpenClaw's pre-bootstrap ritual (src/agents/system-prompt.ts,
// src/auto-reply/reply/session-reset-prompt.ts) emits wording like
// "[Bootstrap pending]" / "Please read BOOTSTRAP.md" into model-bound prompts
// when a workspace is in pre-setup state. For agents connected to Slack, that
// wording lands in Slack's permanent message history, and then comes back
// into the model on every new session via resolveSlackThreadHistory below —
// re-anchoring the agent on bootstrap-pending behavior even after the
// upstream prompt code has been fixed or the workspace has been re-marked as
// complete. This pattern recognizes that wording in inbound thread history
// so we can drop it before it re-enters the model.
const UPSTREAM_BOOTSTRAP_POLLUTION_PATTERN =
  /\[Bootstrap pending\]|BOOTSTRAP\.md|Please read BOOTSTRAP/i;

function isUpstreamBootstrapPollution(text: string | undefined | null): boolean {
  if (!text) {
    return false;
  }
  return UPSTREAM_BOOTSTRAP_POLLUTION_PATTERN.test(text);
}

export type SlackThreadContextData = {
  threadStarterBody: string | undefined;
  threadHistoryBody: string | undefined;
  threadSessionPreviousTimestamp: number | undefined;
  threadLabel: string | undefined;
  threadStarterMedia: SlackMediaResult[] | null;
};

function isSlackThreadContextSenderAllowed(params: {
  allowFromLower: string[];
  allowNameMatching: boolean;
  userId?: string;
  userName?: string;
  botId?: string;
}): boolean {
  if (params.allowFromLower.length === 0 || params.botId) {
    return true;
  }
  if (!params.userId) {
    return false;
  }
  return resolveSlackAllowListMatch({
    allowList: params.allowFromLower,
    id: params.userId,
    name: params.userName,
    allowNameMatching: params.allowNameMatching,
  }).allowed;
}

export async function resolveSlackThreadContextData(params: {
  ctx: SlackMonitorContext;
  account: ResolvedSlackAccount;
  message: SlackMessageEvent;
  isThreadReply: boolean;
  threadTs: string | undefined;
  threadStarter: SlackThreadStarter | null;
  roomLabel: string;
  storePath: string;
  sessionKey: string;
  allowFromLower: string[];
  allowNameMatching: boolean;
  contextVisibilityMode: ContextVisibilityMode;
  envelopeOptions: ReturnType<
    typeof import("openclaw/plugin-sdk/channel-inbound").resolveEnvelopeFormatOptions
  >;
  effectiveDirectMedia: SlackMediaResult[] | null;
}): Promise<SlackThreadContextData> {
  const isCurrentBotAuthor = (author: { userId?: string; botId?: string }): boolean =>
    Boolean(
      (params.ctx.botUserId && author.userId && author.userId === params.ctx.botUserId) ||
      (params.ctx.botId && author.botId && author.botId === params.ctx.botId),
    );

  let threadStarterBody: string | undefined;
  let threadHistoryBody: string | undefined;
  let threadSessionPreviousTimestamp: number | undefined;
  let threadLabel: string | undefined;
  let threadStarterMedia: SlackMediaResult[] | null = null;

  if (!params.isThreadReply || !params.threadTs) {
    return {
      threadStarterBody,
      threadHistoryBody,
      threadSessionPreviousTimestamp,
      threadLabel,
      threadStarterMedia,
    };
  }

  const starter = params.threadStarter;
  const starterSenderName =
    params.allowNameMatching && starter?.userId
      ? (await params.ctx.resolveUserName(starter.userId))?.name
      : undefined;
  const starterIsCurrentBot = Boolean(
    starter &&
    isCurrentBotAuthor({
      userId: starter.userId,
      botId: starter.botId,
    }),
  );
  const starterAllowed =
    !starter ||
    (!starterIsCurrentBot &&
      isSlackThreadContextSenderAllowed({
        allowFromLower: params.allowFromLower,
        allowNameMatching: params.allowNameMatching,
        userId: starter.userId,
        userName: starterSenderName,
        botId: starter.botId,
      }));
  const includeStarterContext =
    !starter ||
    (!starterIsCurrentBot &&
      shouldIncludeSupplementalContext({
        mode: params.contextVisibilityMode,
        kind: "thread",
        senderAllowed: starterAllowed,
      }));

  if (starter?.text && includeStarterContext) {
    threadStarterBody = starter.text;
    const snippet = starter.text.replace(/\s+/g, " ").slice(0, 80);
    threadLabel = `Slack thread ${params.roomLabel}${snippet ? `: ${snippet}` : ""}`;
    if (!params.effectiveDirectMedia && starter.files && starter.files.length > 0) {
      threadStarterMedia = await resolveSlackMedia({
        files: starter.files,
        token: params.ctx.botToken,
        maxBytes: params.ctx.mediaMaxBytes,
      });
      if (threadStarterMedia) {
        const starterPlaceholders = threadStarterMedia.map((item) => item.placeholder).join(", ");
        logVerbose(`slack: hydrated thread starter file ${starterPlaceholders} from root message`);
      }
    }
  } else {
    threadLabel = `Slack thread ${params.roomLabel}`;
  }
  if (starter?.text && starterIsCurrentBot) {
    logVerbose("slack: omitted current-bot thread starter from context");
  } else if (starter?.text && !includeStarterContext) {
    logVerbose(
      `slack: omitted thread starter from context (mode=${params.contextVisibilityMode}, sender_allowed=${starterAllowed ? "yes" : "no"})`,
    );
  }

  const threadInitialHistoryLimit = params.account.config?.thread?.initialHistoryLimit ?? 20;
  threadSessionPreviousTimestamp = readSessionUpdatedAt({
    storePath: params.storePath,
    sessionKey: params.sessionKey,
  });

  if (threadInitialHistoryLimit > 0 && !threadSessionPreviousTimestamp) {
    const threadHistory = await resolveSlackThreadHistory({
      channelId: params.message.channel,
      threadTs: params.threadTs,
      client: params.ctx.app.client,
      currentMessageTs: params.message.ts,
      limit: threadInitialHistoryLimit,
    });

    if (threadHistory.length > 0) {
      const threadHistoryWithoutCurrentBot = threadHistory.filter(
        (historyMsg) =>
          !isCurrentBotAuthor({
            userId: historyMsg.userId,
            botId: historyMsg.botId,
          }),
      );
      const omittedCurrentBotHistoryCount =
        threadHistory.length - threadHistoryWithoutCurrentBot.length;

      // Drop messages whose body was generated by upstream's pre-bootstrap
      // ritual. The current-bot filter above only catches messages authored
      // by this bot's current user/bot id; it misses stale messages from a
      // previous bot provisioning, and any user quoting the bootstrap wording
      // back into the thread. Without this step, those messages re-anchor the
      // agent on bootstrap-pending behavior even on workspaces where setup is
      // actually complete.
      const threadHistoryWithoutPollution = threadHistoryWithoutCurrentBot.filter(
        (historyMsg) => !isUpstreamBootstrapPollution(historyMsg.text),
      );
      const omittedBootstrapPollutionCount =
        threadHistoryWithoutCurrentBot.length - threadHistoryWithoutPollution.length;
      if (omittedBootstrapPollutionCount > 0) {
        logVerbose(
          `slack: omitted ${omittedBootstrapPollutionCount} thread message(s) from context (upstream bootstrap pollution)`,
        );
      }

      const uniqueUserIds = [
        ...new Set(
          threadHistoryWithoutPollution
            .map((item) => item.userId)
            .filter((id): id is string => Boolean(id)),
        ),
      ];
      const userMap = new Map<string, { name?: string }>();
      await Promise.all(
        uniqueUserIds.map(async (id) => {
          const user = await params.ctx.resolveUserName(id);
          if (user) {
            userMap.set(id, user);
          }
        }),
      );

      const { items: filteredThreadHistory, omitted: omittedHistoryCount } =
        filterSupplementalContextItems({
          items: threadHistoryWithoutPollution,
          mode: params.contextVisibilityMode,
          kind: "thread",
          isSenderAllowed: (historyMsg) => {
            const msgUser = historyMsg.userId ? userMap.get(historyMsg.userId) : null;
            return isSlackThreadContextSenderAllowed({
              allowFromLower: params.allowFromLower,
              allowNameMatching: params.allowNameMatching,
              userId: historyMsg.userId,
              userName: msgUser?.name,
              botId: historyMsg.botId,
            });
          },
        });
      if (omittedHistoryCount > 0 || omittedCurrentBotHistoryCount > 0) {
        logVerbose(
          `slack: omitted ${omittedHistoryCount + omittedCurrentBotHistoryCount} thread message(s) from context (mode=${params.contextVisibilityMode})`,
        );
      }

      const historyParts: string[] = [];
      for (const historyMsg of filteredThreadHistory) {
        const msgUser = historyMsg.userId ? userMap.get(historyMsg.userId) : null;
        const isBot = Boolean(historyMsg.botId);
        const msgSenderName = msgUser?.name ?? (isBot ? `Bot (${historyMsg.botId})` : "Unknown");
        const role = isBot ? "assistant" : "user";
        const msgWithId = `${historyMsg.text}\n[slack message id: ${historyMsg.ts ?? "unknown"} channel: ${params.message.channel}]`;
        historyParts.push(
          formatInboundEnvelope({
            channel: "Slack",
            from: `${msgSenderName} (${role})`,
            timestamp: historyMsg.ts ? Math.round(Number(historyMsg.ts) * 1000) : undefined,
            body: msgWithId,
            chatType: "channel",
            envelope: params.envelopeOptions,
          }),
        );
      }
      if (historyParts.length > 0) {
        threadHistoryBody = historyParts.join("\n\n");
        logVerbose(
          `slack: populated thread history with ${filteredThreadHistory.length} messages for new session`,
        );
      }
    }
  }

  return {
    threadStarterBody,
    threadHistoryBody,
    threadSessionPreviousTimestamp,
    threadLabel,
    threadStarterMedia,
  };
}
