import { describe, expect, it } from "vitest";
import { checkUsername } from "#src/players/username";

describe("checkUsername", () => {
  it.each([
    ["falcon", "falcon"],
    ["Falcon_7", "Falcon_7"],
    ["صقر", "صقر"],
    ["صقر_7", "صقر_7"],
    ["  falcon  ", "falcon"],
    ["ｆａｌｃｏｎ", "falcon"],
    ["abc", "abc"],
    ["a_1", "a_1"],
    ["a".repeat(30), "a".repeat(30)],
  ])("takes %j as %j", (raw, username) => {
    expect(checkUsername(raw)).toEqual({ ok: true, username });
  });

  it.each([
    ["ab", "length"],
    ["a".repeat(31), "length"],
    ["", "length"],
    ["fal con", "characters"],
    ["falcon!", "characters"],
    ["صَقر", "characters"],
    ["صـقر", "characters"],
    ["falcon​", "characters"],
    ["‮falcon", "characters"],
    ["falcon٧", "characters"],
    ["___", "characters"],
    ["123", "characters"],
    ["1_2_3", "characters"],
    ["صقرfalcon", "mixed_scripts"],
  ])("refuses %j (%s)", (raw, reason) => {
    expect(checkUsername(raw)).toEqual({ ok: false, reason });
  });
});
