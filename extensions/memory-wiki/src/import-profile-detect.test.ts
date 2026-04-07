import { describe, expect, it } from "vitest";
import { detectChatGptExportSample } from "./import-profile-detect.js";

describe("detectChatGptExportSample", () => {
  it("detects likely ChatGPT exports by filename", () => {
    expect(
      detectChatGptExportSample({
        inputPath: "/tmp/chatgpt-export.json",
        sample: JSON.stringify({ anything: true }),
      }),
    ).toBe(true);
  });

  it("detects likely ChatGPT conversation exports by JSON structure", () => {
    expect(
      detectChatGptExportSample({
        inputPath: "/tmp/export.json",
        sample: JSON.stringify([
          {
            title: "Alpha thread",
            mapping: {
              root: {
                message: {
                  author: { role: "user" },
                  content: { parts: ["hello"] },
                },
              },
            },
          },
        ]),
      }),
    ).toBe(true);
  });

  it("does not flag generic JSON files as ChatGPT exports", () => {
    expect(
      detectChatGptExportSample({
        inputPath: "/tmp/project-notes.json",
        sample: JSON.stringify({
          title: "Alpha notes",
          body: "just a normal note export",
        }),
      }),
    ).toBe(false);
  });
});
