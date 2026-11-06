import { describe, expect, it } from "vitest";
import {
  MESSAGES,
  NO_OVERRIDES,
  createTranslator,
  type Achievement,
  type Language,
  type QuestifySync,
} from "@questify/shared";
import type { Translate } from "#src/i18n/words.ts";
import { syncNotices, wroteSomething } from "#src/questify/sync-notices.ts";

const translate = createTranslator(MESSAGES, NO_OVERRIDES);
const tIn =
  (language: Language): Translate =>
  (key, params) =>
    translate(key, language, params);

const catalog: Achievement[] = [
  {
    id: "events-attended",
    name: { ar: "رحّالة", en: "Wanderer" },
    visualKey: "ach-first-steps",
    tier: "gold",
    progress: 15,
    next: null,
  },
];
const none: QuestifySync = {
  achievements: [],
  quests: [],
  levelUp: null,
  items: [],
  dailyStreak: null,
};

describe("syncNotices", () => {
  it("makes no toast for a sync that wrote nothing", () => {
    expect(syncNotices(none, catalog, tIn("en"), "en")).toEqual([]);
    expect(wroteSomething(none)).toBe(false);
  });

  it("names the achievement and its tier in the screen's language", () => {
    const sync = {
      ...none,
      achievements: [{ id: "events-attended", tier: "bronze" as const, xp: 50 }],
    };
    expect(syncNotices(sync, catalog, tIn("en"), "en")).toEqual([
      "New achievement: Wanderer (Bronze)",
    ]);
    expect(syncNotices(sync, catalog, tIn("ar"), "ar")).toEqual(["إنجاز جديد: رحّالة (برونزي)"]);
  });

  it("shows one toast for an achievement that jumped several tiers, at the highest", () => {
    const sync = {
      ...none,
      achievements: [
        { id: "events-attended", tier: "bronze" as const, xp: 50 },
        { id: "events-attended", tier: "gold" as const, xp: 300 },
        { id: "events-attended", tier: "silver" as const, xp: 150 },
      ],
    };
    expect(syncNotices(sync, catalog, tIn("en"), "en")).toEqual([
      "New achievement: Wanderer (Gold)",
    ]);
  });

  it("still tells the player when the catalog did not load or does not know the achievement", () => {
    const sync = {
      ...none,
      achievements: [{ id: "events-attended", tier: "silver" as const, xp: 150 }],
    };
    expect(syncNotices(sync, null, tIn("en"), "en")).toEqual(["You unlocked a new achievement."]);
    expect(syncNotices(sync, [], tIn("ar"), "ar")).toEqual(["فتحت إنجازًا جديدًا."]);
  });

  it("says each Questify quest with its XP, in Western digits", () => {
    const sync = {
      ...none,
      quests: [
        {
          id: "6f1c7a0e-0000-4000-8000-000000000001",
          title: { ar: "العب في مدينتين", en: "Play in 2 cities" },
          xp: 300,
        },
      ],
    };
    expect(syncNotices(sync, catalog, tIn("en"), "en")).toEqual([
      "Quest done: Play in 2 cities (+300 XP)",
    ]);
    expect(syncNotices(sync, catalog, tIn("ar"), "ar")).toEqual([
      "أنجزت مهمة: العب في مدينتين (+300 XP)",
    ]);
  });

  it("counts a level-up alone as something written, with no toast of its own", () => {
    const sync = {
      ...none,
      levelUp: { level: 3, title: { ar: "مستكشف", en: "Explorer" }, items: [] },
    };
    expect(wroteSomething(sync)).toBe(true);
    expect(syncNotices(sync, catalog, tIn("en"), "en")).toEqual([]);
  });

  it("adds one toast for each daily streak milestone, after the quests (T-405b)", () => {
    const sync = {
      ...none,
      dailyStreak: {
        days: 7,
        today: true,
        next: { days: 14, xp: 150 },
        rewards: [
          { days: 3, xp: 50 },
          { days: 7, xp: 100 },
        ],
      },
    };
    expect(syncNotices(sync, catalog, tIn("en"), "en")).toEqual([
      "Streak of 3 days! +50 XP",
      "Streak of 7 days! +100 XP",
    ]);
    expect(syncNotices(sync, catalog, tIn("ar"), "ar")[0]).toBe("سلسلة 3 أيام! ‎+50 XP");
  });

  it("makes no streak toast when nothing was paid or the streak is off, and counts a paid milestone as written", () => {
    const counted = { days: 2, today: true, next: { days: 3, xp: 50 }, rewards: [] };
    expect(syncNotices({ ...none, dailyStreak: counted }, catalog, tIn("en"), "en")).toEqual([]);
    expect(wroteSomething({ ...none, dailyStreak: counted })).toBe(false);
    const paid = { ...counted, days: 3, rewards: [{ days: 3, xp: 50 }] };
    expect(wroteSomething({ ...none, dailyStreak: paid })).toBe(true);
    expect(wroteSomething(none)).toBe(false);
  });

  it("counts a sync that only gave an achievement item as something written (T-404c)", () => {
    const item = {
      id: "ring",
      kind: "frame" as const,
      name: { ar: "ا", en: "A" },
      visualKey: "frame-16",
    };
    const given = { achievementId: "top-ten", tier: "gold" as const, item };
    expect(wroteSomething({ ...none, items: [given] })).toBe(true);
  });
});
