import { describe, expect, it } from "vitest";
import {
  MESSAGES,
  NO_OVERRIDES,
  createTranslator,
  formatNumber,
  type AchievementReward,
  type Language,
  type LevelRewards,
  type ProfileItem,
} from "@questify/shared";
import type { Translate } from "#src/i18n/words.ts";
import { levelProgress } from "#src/questify/level.ts";
import {
  achievementLabel,
  achievementState,
  levelOfRewards,
  lockerStartKind,
  nextReward,
  nextRewardLabel,
  plaqueLabel,
  previewNamesItem,
  reachLine,
  stoneLabel,
  stonesOf,
  xpLine,
  type Stone,
} from "#src/questify/journey.ts";

const translate = createTranslator(MESSAGES, NO_OVERRIDES);
const tIn =
  (language: Language): Translate =>
  (key, params) =>
    translate(key, language, params);

const item = (id: string, en: string, ar: string): ProfileItem => ({
  id,
  kind: "frame",
  name: { ar, en },
  visualKey: "frame-02",
});
const ring = item("level-2", "Green ring", "إطار أخضر");
const title = item("level-3", "Scout", "كشّاف");
const crown = item("level-4", "Crown", "تاج");

const rewards: LevelRewards = {
  level: {
    number: 3,
    title: { ar: "مستكشف", en: "Explorer" },
    xp: 350,
    levelFrom: 300,
    nextLevelAt: 600,
  },
  levels: [
    { level: 1, xpFrom: 0, item: null, owned: false },
    { level: 2, xpFrom: 100, item: ring, owned: true },
    { level: 3, xpFrom: 300, item: title, owned: true },
    { level: 4, xpFrom: 600, item: crown, owned: false },
    { level: 5, xpFrom: 1000, item: null, owned: false },
    { level: 6, xpFrom: 1500, item: ring, owned: false },
  ],
  achievements: [],
};

const wanderer = (patch: Partial<AchievementReward>): AchievementReward => ({
  id: "events-attended",
  name: { ar: "رحّالة", en: "Wanderer" },
  visualKey: "ach-first-steps",
  tier: "gold",
  item: ring,
  owned: false,
  earned: false,
  ...patch,
});

describe("the level trail", () => {
  it("marks each level reached, current or locked from the player's own level", () => {
    expect(stonesOf(rewards).map((stone) => stone.state)).toEqual([
      "reached",
      "reached",
      "current",
      "locked",
      "locked",
      "locked",
    ]);
  });

  it("keeps the curve's order and each level's item and ownership", () => {
    const stones = stonesOf(rewards);
    expect(stones.map((stone) => stone.level)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(stones[1]).toMatchObject({ item: ring, owned: true, xpFrom: 100 });
    expect(stones[3]).toMatchObject({ item: crown, owned: false });
  });

  it("is all reached or current for a player above a shortened curve, and has no next reward", () => {
    const above = { ...rewards, level: { ...rewards.level, number: 9 } };
    expect(stonesOf(above).every((stone) => stone.state === "reached")).toBe(true);
    expect(nextReward(stonesOf(above))).toBeNull();
  });

  it("finds the nearest level ahead that gives an item, skipping one that gives nothing", () => {
    expect(nextReward(stonesOf(rewards))).toEqual({ level: 4, item: crown });
    const skipping = { ...rewards, level: { ...rewards.level, number: 4 } };
    expect(nextReward(stonesOf(skipping))).toEqual({ level: 6, item: ring });
  });

  it("has no next reward at the top level", () => {
    const top = { ...rewards, level: { ...rewards.level, number: 6 } };
    expect(nextReward(stonesOf(top))).toBeNull();
  });
});

describe("the level bar", () => {
  it("is read by the profile's own progress rule", () => {
    expect(levelProgress(levelOfRewards(rewards))).toBeCloseTo(50 / 300, 5);
    expect(levelOfRewards(rewards).title).toEqual(rewards.level.title);
  });

  it("says how far the next level is, with Western digits in both languages", () => {
    const big = { ...rewards, level: { ...rewards.level, xp: 1400, nextLevelAt: 2000 } };
    for (const language of ["en", "ar"] as const) {
      const line = xpLine(tIn(language), big, (value) => formatNumber(value, language));
      expect(line).toContain("1,400");
      expect(line).toContain("2,000");
      expect(line).toMatch(/XP$/);
      expect(line).not.toMatch(/[٠-٩]/);
    }
    expect(xpLine(tIn("en"), big, (value) => formatNumber(value, "en"))).toBe("1,400 of 2,000 XP");
  });

  it("says the top level is reached when there is no next level", () => {
    const top = { ...rewards, level: { ...rewards.level, nextLevelAt: null } };
    expect(xpLine(tIn("en"), top, String)).toBe("Top level reached");
    expect(xpLine(tIn("ar"), top, String)).toBe("بلغت أعلى مستوى");
  });
});

describe("lockerStartKind", () => {
  it("opens the locker on the tab of the item's kind", () => {
    expect(lockerStartKind("frame")).toBe("frame");
    expect(lockerStartKind("title")).toBe("title");
    expect(lockerStartKind("character")).toBe("character");
  });

  it("knows nothing of any other value, so the locker starts where it always did", () => {
    for (const value of [undefined, null, "", "Frame", "gem", ["frame"], 3]) {
      expect(lockerStartKind(value)).toBe("character");
    }
  });
});

describe("what a screen reader says", () => {
  const stones = stonesOf(rewards);
  const empty = (state: Stone["state"]): Stone => ({ ...stones[4]!, state });

  it("names the level, the item and where the player stands, in both languages", () => {
    expect(stoneLabel(tIn("en"), "en", stones[1]!)).toBe("Level 2 reached: Green ring");
    expect(stoneLabel(tIn("en"), "en", stones[2]!)).toBe("You are at level 3: Scout");
    expect(stoneLabel(tIn("en"), "en", stones[3]!)).toBe("Level 4 locked: Crown");
    expect(stoneLabel(tIn("ar"), "ar", stones[1]!)).toBe("بلغت المستوى 2: إطار أخضر");
    expect(stoneLabel(tIn("ar"), "ar", stones[2]!)).toBe("أنت في المستوى 3: كشّاف");
    expect(stoneLabel(tIn("ar"), "ar", stones[3]!)).toBe("المستوى 4 مقفل: تاج");
  });

  it("calls level 1 the start", () => {
    expect(stoneLabel(tIn("en"), "en", stones[0]!)).toBe("Level 1: where you start");
    expect(stoneLabel(tIn("ar"), "ar", stones[0]!)).toBe("المستوى 1: نقطة البداية");
  });

  it("says only where the player stands at a later level that gives no item", () => {
    expect(stoneLabel(tIn("en"), "en", empty("locked"))).toBe("Level 5 locked");
    expect(stoneLabel(tIn("en"), "en", empty("current"))).toBe("You are at level 5");
    expect(stoneLabel(tIn("en"), "en", empty("reached"))).toBe("Level 5 reached");
    expect(stoneLabel(tIn("ar"), "ar", empty("locked"))).toBe("المستوى 5 مقفل");
    expect(stoneLabel(tIn("ar"), "ar", empty("current"))).toBe("أنت في المستوى 5");
    expect(stoneLabel(tIn("ar"), "ar", empty("reached"))).toBe("بلغت المستوى 5");
  });

  it("joins the plaque's and the next reward's words with each language's comma", () => {
    expect(plaqueLabel(tIn("en"), "en", rewards)).toBe("Level 3, Explorer");
    expect(plaqueLabel(tIn("ar"), "ar", rewards)).toBe("المستوى 3، مستكشف");
    expect(nextRewardLabel(tIn("en"), "en", 4, crown)).toBe("Next reward: Crown, Level 4");
    expect(nextRewardLabel(tIn("ar"), "ar", 4, crown)).toBe("المكافأة التالية: تاج، المستوى 4");
  });

  it("leaves a title's name to its name plate and names the other kinds beside them", () => {
    expect(previewNamesItem({ ...title, kind: "title" })).toBe(true);
    expect(previewNamesItem({ ...ring, kind: "frame" })).toBe(false);
    expect(previewNamesItem({ ...ring, kind: "character" })).toBe(false);
  });

  it("tells the three states of an achievement reward apart", () => {
    expect(achievementState(wanderer({ owned: true, earned: true }))).toBe("owned");
    expect(achievementState(wanderer({ earned: true }))).toBe("soon");
    expect(achievementState(wanderer({}))).toBe("locked");
  });

  it("says what to do to unlock an item, at the tier the achievement gives it", () => {
    expect(reachLine(tIn("en"), "en", wanderer({}))).toBe("Reach gold in Wanderer");
    expect(reachLine(tIn("en"), "en", wanderer({ tier: "bronze" }))).toBe(
      "Reach bronze in Wanderer",
    );
    expect(reachLine(tIn("ar"), "ar", wanderer({ tier: "silver" }))).toBe(
      "ابلغ الدرجة الفضية في إنجاز رحّالة",
    );
  });

  it("labels an achievement reward in each state", () => {
    const en = tIn("en");
    expect(achievementLabel(en, "en", wanderer({ owned: true, earned: true }))).toBe(
      "You have Green ring from Wanderer",
    );
    expect(achievementLabel(en, "en", wanderer({ earned: true }))).toBe(
      "Green ring from Wanderer is on its way",
    );
    expect(achievementLabel(en, "en", wanderer({}))).toBe("Green ring: Reach gold in Wanderer");
    expect(achievementLabel(tIn("ar"), "ar", wanderer({}))).toBe(
      "إطار أخضر: ابلغ الدرجة الذهبية في إنجاز رحّالة",
    );
    expect(achievementLabel(tIn("ar"), "ar", wanderer({ earned: true }))).toBe(
      "ستحصل على إطار أخضر من إنجاز رحّالة قريبًا",
    );
  });

  it("never names a price, a purchase or a currency of Questify", () => {
    const words = Object.entries(MESSAGES)
      .filter(([key]) => key.startsWith("journey.") || key === "nav.journey")
      .flatMap(([, text]) => [text.en, text.ar]);
    expect(words.length).toBeGreaterThan(10);
    for (const text of words) {
      expect(text).not.toMatch(/\b(buy|bought|get|price|cost|gems?|spend|purchase|pay)\b/i);
      expect(text).not.toMatch(/شراء|اشتر|سعر|جوهر|جواهر|ادفع|تكلفة/);
    }
  });
});
