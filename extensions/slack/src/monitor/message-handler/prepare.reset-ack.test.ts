import type { App } from "@slack/bolt";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SlackMessageEvent } from "../../types.js";

const sendMock = vi.fn();
vi.mock("../send.runtime.js", () => ({
  sendMessageSlack: (...args: unknown[]) => sendMock(...args),
}));

const [{ prepareSlackMessage }, helpers] = await Promise.all([
  import("./prepare.js"),
  import("./prepare.test-helpers.js"),
]);
const { createInboundSlackTestContext, createSlackTestAccount } = helpers;

function buildCtxWithResetTriggers(
  triggers: string[],
  overrides?: { replyToMode?: "all" | "first" | "off"; defaultRequireMention?: boolean },
) {
  const replyToMode = overrides?.replyToMode ?? "all";
  return createInboundSlackTestContext({
    cfg: {
      channels: { slack: { enabled: true, replyToMode } },
      session: { resetTriggers: triggers },
    } as OpenClawConfig,
    appClient: {} as App["client"],
    defaultRequireMention: overrides?.defaultRequireMention ?? false,
    replyToMode,
  });
}

function buildChannelMessage(overrides?: Partial<SlackMessageEvent>): SlackMessageEvent {
  return {
    channel: "C123",
    channel_type: "channel",
    user: "U1",
    text: "RESET",
    ts: "1770408518.451689",
    ...overrides,
  } as SlackMessageEvent;
}

function buildDmMessage(overrides?: Partial<SlackMessageEvent>): SlackMessageEvent {
  return {
    channel: "D123",
    channel_type: "im",
    user: "U1",
    text: "RESET",
    ts: "1770408518.451689",
    ...overrides,
  } as SlackMessageEvent;
}

describe("slack session-reset ACK", () => {
  beforeEach(() => {
    sendMock.mockReset();
    sendMock.mockResolvedValue({ messageId: "ack.0", channelId: "C123" });
  });

  it("posts a pre-LLM ACK in the same thread when a resetTrigger fires in a channel", async () => {
    const ctx = buildCtxWithResetTriggers(["RESET"]);
    ctx.resolveUserName = async () => ({ name: "Alice" });
    const account = createSlackTestAccount({ replyToMode: "all" });

    const prepared = await prepareSlackMessage({
      ctx,
      account,
      message: buildChannelMessage({
        thread_ts: "1770408500.000000",
        text: "<@B1> RESET",
      }),
      opts: { source: "message" },
    });

    expect(prepared).toBeTruthy();
    expect(sendMock).toHaveBeenCalledOnce();
    const [to, text, opts] = sendMock.mock.calls[0] as [string, string, Record<string, unknown>];
    expect(to).toBe("C123");
    expect(text).toBe("ACK. RESETTING");
    expect(opts.threadTs).toBe("1770408500.000000");
  });

  it("threads the ACK under the reset-trigger message when the message is top-level", async () => {
    const ctx = buildCtxWithResetTriggers(["RESET"]);
    ctx.resolveUserName = async () => ({ name: "Alice" });
    const account = createSlackTestAccount({ replyToMode: "all" });

    const prepared = await prepareSlackMessage({
      ctx,
      account,
      message: buildChannelMessage({ text: "<@B1> RESET", ts: "1770408600.000000" }),
      opts: { source: "message" },
    });

    expect(prepared).toBeTruthy();
    expect(sendMock).toHaveBeenCalledOnce();
    const [, , opts] = sendMock.mock.calls[0] as [string, string, Record<string, unknown>];
    expect(opts.threadTs).toBe("1770408600.000000");
  });

  it("skips the threadTs in DMs (DMs don't thread)", async () => {
    const ctx = buildCtxWithResetTriggers(["RESET"]);
    ctx.resolveUserName = async () => ({ name: "Alice" });
    ctx.resolveChannelName = async () => ({ name: undefined, type: "im" as const });
    const account = createSlackTestAccount();

    const prepared = await prepareSlackMessage({
      ctx,
      account,
      message: buildDmMessage(),
      opts: { source: "message" },
    });

    expect(prepared).toBeTruthy();
    expect(sendMock).toHaveBeenCalledOnce();
    const [to, text, opts] = sendMock.mock.calls[0] as [string, string, Record<string, unknown>];
    expect(to).toBe("D123");
    expect(text).toBe("ACK. RESETTING");
    expect(opts.threadTs).toBeUndefined();
  });

  it("does not post an ACK for non-reset messages", async () => {
    const ctx = buildCtxWithResetTriggers(["RESET"]);
    ctx.resolveUserName = async () => ({ name: "Alice" });
    const account = createSlackTestAccount({ replyToMode: "all" });

    const prepared = await prepareSlackMessage({
      ctx,
      account,
      message: buildChannelMessage({ text: "<@B1> hello world" }),
      opts: { source: "message" },
    });

    expect(prepared).toBeTruthy();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("matches case-insensitively and allows a variety of configured triggers", async () => {
    const ctx = buildCtxWithResetTriggers(["RESET", "!reset", "/reset"]);
    ctx.resolveUserName = async () => ({ name: "Alice" });
    const account = createSlackTestAccount({ replyToMode: "all" });

    for (const text of ["<@B1> reset", "<@B1> !reset", "<@B1> RESET"]) {
      sendMock.mockClear();
      await prepareSlackMessage({
        ctx,
        account,
        message: buildChannelMessage({ text, ts: `${Date.now()}.${Math.random()}` }),
        opts: { source: "message" },
      });
      expect(sendMock).toHaveBeenCalledOnce();
      expect(sendMock.mock.calls[0][1]).toBe("ACK. RESETTING");
    }
  });

  it("does not post an ACK when the sender is unauthorized in a room with allowlist", async () => {
    const ctx = createInboundSlackTestContext({
      cfg: {
        channels: { slack: { enabled: true, replyToMode: "all" } },
        session: { resetTriggers: ["RESET"] },
      } as OpenClawConfig,
      appClient: {} as App["client"],
      defaultRequireMention: false,
      replyToMode: "all",
      channelsConfig: { C123: { users: ["U-authorized-only"] } },
    });
    ctx.resolveUserName = async () => ({ name: "Attacker" });
    const account = createSlackTestAccount({ replyToMode: "all" });

    const prepared = await prepareSlackMessage({
      ctx,
      account,
      message: buildChannelMessage({ user: "U-outsider", text: "<@B1> RESET" }),
      opts: { source: "message" },
    });

    expect(prepared).toBeNull();
    expect(sendMock).not.toHaveBeenCalled();
  });
});
