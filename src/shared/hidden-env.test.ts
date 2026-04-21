import { describe, expect, it } from "vitest";
import {
  DECISIONAL_TOKEN_ENV_KEY,
  coerceAllowedHiddenEnv,
  findDisallowedHiddenEnvKeys,
  getAllowedHiddenEnvKeys,
} from "./hidden-env.js";

describe("hidden env helpers", () => {
  it("keeps only allowed hidden env keys", () => {
    expect(
      coerceAllowedHiddenEnv({
        DECISIONAL_TOKEN: "dex_scoped",
        LD_PRELOAD: "/tmp/evil",
        EMPTY: "   ",
      }),
    ).toEqual({ DECISIONAL_TOKEN: "dex_scoped" });
  });

  it("returns undefined when no allowed hidden env keys remain", () => {
    expect(coerceAllowedHiddenEnv({ LD_PRELOAD: "/tmp/evil" })).toBeUndefined();
  });

  it("finds disallowed hidden env keys for exec defense in depth", () => {
    expect(
      findDisallowedHiddenEnvKeys({
        DECISIONAL_TOKEN: "dex_scoped",
        LD_PRELOAD: "/tmp/evil",
      }),
    ).toEqual(["LD_PRELOAD"]);
    expect(getAllowedHiddenEnvKeys()).toEqual([DECISIONAL_TOKEN_ENV_KEY]);
  });
});
