import { describe, expect, it } from "vitest";
import { playerIntroDocSchema } from "#src/catalog/catalog";
import { composeConfig } from "#src/config/compose";
import { readPlatformSettings } from "#src/config/read";
import { REGISTRIES } from "#src/config/registry";
import { parseComposedConfig } from "#src/config/validate";
import {
  DEFAULT_COMPOSED_PLAYER_INTRO,
  DEFAULT_PLAYER_INTRO,
  PLAYER_INTRO_CARDS,
  PLAYER_INTRO_KEYS,
  checkPlayerIntro,
  composedPlayerIntroOf,
  readComposedPlayerIntro,
  readPlayerIntro,
  samePlayerIntro,
} from "#src/layout/player-intro";

const intro = (overrides: Record<string, unknown> = {}) => ({
  order: PLAYER_INTRO_KEYS,
  hidden: [],
  ...overrides,
});
const issuesOf = (input: unknown): string[] => {
  const checked = checkPlayerIntro(input);
  return checked.ok ? [] : checked.issues.map((issue) => `${issue.path}: ${issue.message}`);
};

describe("the player intro's cards (T-802b, FR-1803)", () => {
  it("plays the four cards in the order the intro always had, all shown", () => {
    expect(PLAYER_INTRO_KEYS).toEqual(["join", "quests", "points", "prizes"]);
    expect(DEFAULT_PLAYER_INTRO).toEqual({ order: PLAYER_INTRO_KEYS, hidden: [] });
    expect(DEFAULT_COMPOSED_PLAYER_INTRO).toEqual({ cards: PLAYER_INTRO_KEYS });
  });

  it("names each card by the title the intro shows, in the cards' own order", () => {
    expect(PLAYER_INTRO_CARDS.map((entry) => entry.title)).toEqual([
      "onboarding.card1.title",
      "onboarding.card2.title",
      "onboarding.card3.title",
      "onboarding.card4.title",
    ]);
  });
});

describe("reading a stored intro", () => {
  it("is the shipped intro when nothing, or something that is not an object, is stored", () => {
    for (const stored of [undefined, null, "x", 3, [], {}]) {
      expect(readPlayerIntro(stored)).toEqual(DEFAULT_PLAYER_INTRO);
    }
  });

  it("keeps the stored order and hidden cards, and lets a missing card join the end", () => {
    expect(readPlayerIntro({ order: ["prizes", "join"], hidden: ["join"] })).toEqual({
      order: ["prizes", "join", "quests", "points"],
      hidden: ["join"],
    });
  });

  it("drops names it does not know and counts a card listed twice once", () => {
    expect(
      readPlayerIntro({
        order: ["points", "ghost", "points"],
        hidden: ["ghost", "quests", "quests"],
      }),
    ).toEqual({ order: ["points", "join", "quests", "prizes"], hidden: ["quests"] });
  });

  it("shows every card when the stored intro hides them all", () => {
    expect(readPlayerIntro({ order: ["prizes"], hidden: [...PLAYER_INTRO_KEYS] })).toEqual({
      order: ["prizes", "join", "quests", "points"],
      hidden: [],
    });
  });
});

describe("checking an intro an admin saves", () => {
  it("accepts the default, a reorder and a hidden card, returning them as they are", () => {
    expect(checkPlayerIntro(intro())).toEqual({ ok: true, value: DEFAULT_PLAYER_INTRO });
    const order = ["prizes", "points", "quests", "join"];
    expect(checkPlayerIntro(intro({ order, hidden: ["points"] }))).toEqual({
      ok: true,
      value: { order, hidden: ["points"] },
    });
  });

  it("accepts three hidden cards, so one plays", () => {
    expect(checkPlayerIntro(intro({ hidden: ["join", "quests", "points"] })).ok).toBe(true);
  });

  it("refuses to hide every card", () => {
    expect(issuesOf(intro({ hidden: [...PLAYER_INTRO_KEYS] }))).toEqual([
      "hidden: at least one card must be shown",
    ]);
  });

  it("refuses what is not an object, a missing part and a part that is not the intro's", () => {
    expect(issuesOf("x")).toEqual([": must be an object"]);
    expect(issuesOf(null)).toEqual([": must be an object"]);
    expect(issuesOf({ order: PLAYER_INTRO_KEYS })).toEqual(["hidden: is required"]);
    expect(issuesOf(intro({ extra: 1 }))).toEqual(["extra: is not a part of the intro"]);
  });

  it("refuses an order that is not a list, leaves a card out, lists one twice or names one that does not exist", () => {
    expect(issuesOf(intro({ order: "join" }))).toEqual(["order: must be a list"]);
    expect(issuesOf(intro({ order: PLAYER_INTRO_KEYS.slice(1) }))).toEqual([
      "order: must list join",
    ]);
    expect(issuesOf(intro({ order: [...PLAYER_INTRO_KEYS, "join"] }))).toEqual([
      "order.4: is listed twice",
    ]);
    expect(issuesOf(intro({ order: [...PLAYER_INTRO_KEYS.slice(1), "ghost"] }))).toEqual([
      "order.3: is not a card of the intro",
    ]);
    expect(issuesOf(intro({ order: [...PLAYER_INTRO_KEYS.slice(1), 7] }))).toEqual([
      "order.3: is not a card of the intro",
    ]);
  });

  it("refuses a hidden list that is not a list, names an unknown card or one twice", () => {
    expect(issuesOf(intro({ hidden: "join" }))).toEqual(["hidden: must be a list"]);
    expect(issuesOf(intro({ hidden: ["ghost"] }))).toEqual([
      "hidden.0: is not a card of the intro",
    ]);
    expect(issuesOf(intro({ hidden: ["join", "join"] }))).toEqual(["hidden.1: is listed twice"]);
    expect(issuesOf(intro({ hidden: [3] }))).toEqual(["hidden.0: is not a card of the intro"]);
  });

  it("is the schema the console's routes use, with the issue paths split", () => {
    expect(playerIntroDocSchema.safeParse(intro()).success).toBe(true);
    const refused = playerIntroDocSchema.safeParse(intro({ hidden: ["ghost"] }));
    expect(refused.success ? [] : refused.error.issues.map((issue) => issue.path)).toEqual([
      ["hidden", "0"],
    ]);
  });
});

describe("what the app receives", () => {
  it("plays the shown cards in the order saved", () => {
    const composed = composedPlayerIntroOf(
      readPlayerIntro(intro({ order: ["prizes", "points", "quests", "join"], hidden: ["points"] })),
    );
    expect(composed.cards).toEqual(["prizes", "quests", "join"]);
  });

  it("reads a received copy tolerantly and falls back to the shipped intro", () => {
    for (const received of [undefined, null, "x", {}, { cards: "x" }, { cards: [] }]) {
      expect(readComposedPlayerIntro(received)).toEqual(DEFAULT_COMPOSED_PLAYER_INTRO);
    }
  });

  it("drops a card a newer server added and plays the rest in order", () => {
    expect(readComposedPlayerIntro({ cards: ["points", "ghost", "join", "points"] }).cards).toEqual(
      ["points", "join"],
    );
  });

  it("plays the shipped intro when a newer server's list holds only cards this app lacks", () => {
    expect(readComposedPlayerIntro({ cards: ["mascot", "ghost"] })).toEqual(
      DEFAULT_COMPOSED_PLAYER_INTRO,
    );
  });

  it("compares intros by order and hidden set", () => {
    const a = readPlayerIntro(intro({ hidden: ["join", "quests"] }));
    expect(samePlayerIntro(a, readPlayerIntro(intro({ hidden: ["quests", "join"] })))).toBe(true);
    expect(samePlayerIntro(a, { ...a, hidden: ["join"] })).toBe(false);
    expect(samePlayerIntro(a, { ...a, order: [...a.order].toReversed() })).toBe(false);
  });
});

describe("in the composed configuration", () => {
  it("is the shipped intro when none is stored and the stored one when there is", () => {
    expect(composeConfig(REGISTRIES, {}, undefined).playerIntro).toEqual(
      DEFAULT_COMPOSED_PLAYER_INTRO,
    );
    const platform = readPlatformSettings({
      playerIntro: intro({ order: [...PLAYER_INTRO_KEYS].toReversed(), hidden: ["points"] }),
    });
    expect(composeConfig(REGISTRIES, platform, undefined).playerIntro.cards).toEqual([
      "prizes",
      "quests",
      "join",
    ]);
  });

  it("survives the app's own parse, and a copy from before the intro could be edited reads as the shipped one", () => {
    const body = composeConfig(
      REGISTRIES,
      readPlatformSettings({ playerIntro: intro({ hidden: ["join"] }) }),
      undefined,
    );
    const withLegal = { ...body, legal: { documents: [] } };
    const parsed = parseComposedConfig(withLegal);
    expect(parsed.ok && parsed.config.playerIntro.cards).toEqual(["quests", "points", "prizes"]);
    const { playerIntro: _unused, ...older } = withLegal;
    const parsedOlder = parseComposedConfig(older);
    expect(parsedOlder.ok && parsedOlder.config.playerIntro).toEqual(DEFAULT_COMPOSED_PLAYER_INTRO);
  });
});
