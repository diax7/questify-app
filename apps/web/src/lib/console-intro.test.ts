import { PLAYER_INTRO_KEYS, type PlayerIntro } from "@questify/shared";
import { describe, expect, it } from "vitest";
import { hidesEveryCard, readPlayerIntroRow } from "#src/lib/console-intro.ts";

describe("the console's reading of the player intro (T-802b)", () => {
  it("reads the listed intro and whether it can be reverted", () => {
    const row = readPlayerIntroRow({
      order: [...PLAYER_INTRO_KEYS].toReversed(),
      hidden: ["quests"],
      revertible: true,
    });
    expect(row?.revertible).toBe(true);
    expect(row?.intro.order[0]).toBe("prizes");
    expect(row?.intro.hidden).toEqual(["quests"]);
  });

  it("makes the intro whole when a card is missing, and drops one that is not a card", () => {
    const row = readPlayerIntroRow({
      order: ["prizes", "ghost"],
      hidden: ["ghost"],
      revertible: false,
    });
    expect(row?.intro).toEqual({ order: ["prizes", "join", "quests", "points"], hidden: [] });
  });

  it("answers undefined for a body that is not the expected shape", () => {
    for (const body of [
      null,
      "x",
      {},
      { order: [], hidden: [] },
      { order: 1, hidden: [], revertible: true },
    ]) {
      expect(readPlayerIntroRow(body), JSON.stringify(body)).toBeUndefined();
    }
  });
});

const draft = (hidden: PlayerIntro["hidden"]): PlayerIntro => ({
  order: PLAYER_INTRO_KEYS,
  hidden,
});

describe("hiding every card", () => {
  it("is true only when all four are hidden", () => {
    expect(hidesEveryCard(draft([]))).toBe(false);
    expect(hidesEveryCard(draft(["join", "quests", "points"]))).toBe(false);
    expect(hidesEveryCard(draft(["join", "quests", "points", "prizes"]))).toBe(true);
  });
});
