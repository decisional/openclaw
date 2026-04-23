import { describe, expect, it } from "vitest";
import { resolveAutodexChannel } from "./channel.js";

describe("resolveAutodexChannel", () => {
  it("maps any slack segment to slack", () => {
    // Real shape observed in prod — slack is NOT always the first segment.
    expect(resolveAutodexChannel("agent:main:slack:channel:c07svgrmcby")).toBe("slack");
    expect(resolveAutodexChannel("agent:main:slack:thread:1699999999.012345")).toBe("slack");
    // Legacy short form with slack as the first segment still works.
    expect(resolveAutodexChannel("slack:C0123ABC")).toBe("slack");
    expect(resolveAutodexChannel("slack:channel:C0123ABC")).toBe("slack");
    expect(resolveAutodexChannel("slack:thread:1699999999.012345")).toBe("slack");
    // Case-insensitive.
    expect(resolveAutodexChannel("AGENT:MAIN:SLACK:CHANNEL:C1")).toBe("slack");
  });

  it("maps work-context sessions to frontend", () => {
    // Autodex-initiated chat flows through work-context bindings and ends up
    // in OpenClaw's transcript with this shape. Used to be classified as tui
    // alongside local CLI — distinguishing them matters for the admin
    // filter dropdown.
    expect(resolveAutodexChannel("agent:main:work-context:b890da235e9e357968de6d91")).toBe(
      "frontend",
    );
    expect(resolveAutodexChannel("AGENT:MAIN:WORK-CONTEXT:abc123")).toBe("frontend");
  });

  it("falls back to tui for local CLI keys", () => {
    expect(resolveAutodexChannel("agent:main:main")).toBe("tui");
    expect(resolveAutodexChannel("tui:embedded:xyz")).toBe("tui");
    expect(resolveAutodexChannel("direct:abc")).toBe("tui");
  });

  it("falls back to tui for empty / missing keys", () => {
    expect(resolveAutodexChannel("")).toBe("tui");
    expect(resolveAutodexChannel(null)).toBe("tui");
    expect(resolveAutodexChannel(undefined)).toBe("tui");
  });

  it("does not match substrings — the check is segment-exact", () => {
    // "slackish" shouldn't match "slack"; "work-context-test" shouldn't match
    // "work-context". Avoids an obvious class of false positives if someone
    // later introduces a key name containing either token.
    expect(resolveAutodexChannel("agent:main:slackish:foo")).toBe("tui");
    expect(resolveAutodexChannel("agent:main:work-context-test:foo")).toBe("tui");
  });
});
