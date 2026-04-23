import { describe, expect, it } from "vitest";
import { resolveAutodexChannel } from "./channel.js";

describe("resolveAutodexChannel", () => {
  it("maps slack-prefixed keys to slack", () => {
    expect(resolveAutodexChannel("slack:C0123ABC")).toBe("slack");
    expect(resolveAutodexChannel("slack:channel:C0123ABC")).toBe("slack");
    expect(resolveAutodexChannel("slack:thread:1699999999.012345")).toBe("slack");
    expect(resolveAutodexChannel("SLACK:channel:C1")).toBe("slack");
  });

  it("falls back to tui for anything else", () => {
    expect(resolveAutodexChannel("agent:main:main")).toBe("tui");
    expect(resolveAutodexChannel("tui:embedded:xyz")).toBe("tui");
    expect(resolveAutodexChannel("direct:abc")).toBe("tui");
    expect(resolveAutodexChannel("")).toBe("tui");
    expect(resolveAutodexChannel(null)).toBe("tui");
    expect(resolveAutodexChannel(undefined)).toBe("tui");
  });
});
