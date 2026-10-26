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
  gems: { earned: 0, balance: 0 },
};

describe("syncNotices", () => {
  it("makes no toast for a sync that wrote nothing", () => {
    expect(syncNotices(none, catalog, tIn("en"), "en")).toEqual([]);
    expect(wroteSomething(none)).toBe(false);
  });

  it("names the achievement and its tier in the screen's language", () => {
    const sync = { ...none, achievements: [{ id: "events-attended", tier: "bronze" as const }] };
    expect(syncNotices(sync, catalog, tIn("en"), "en")).toEqual([
      "New achievement: Wanderer (Bronze)",
    ]);
    expect(syncNotices(sync, catalog, tIn("ar"), "ar")).toEqual(["إنجاز جديد: رحّالة (برونزي)"]);
  });

  it("shows one toast for an achievement that jumped several tiers, at the highest", () => {
    const sync = {
      ...none,
      achievements: [
        { id: "events-attended", tier: "bronze" as const },
        { id: "events-attended", tier: "gold" as const },
        { id: "events-attended", tier: "silver" as const },
      ],
    };
    expect(syncNotices(sync, catalog, tIn("en"), "en")).toEqual([
      "New achievement: Wanderer (Gold)",
    ]);
  });

  it("still tells the player when the catalog did not load or does not know the achievement", () => {
    const sync = { ...none, achievements: [{ id: "events-attended", tier: "silver" as const }] };
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

  it("adds one gems line for everything the sync paid, after the other toasts", () => {
    const sync = {
      ...none,
      achievements: [{ id: "events-attended", tier: "bronze" as const }],
      gems: { earned: 30, balance: 130 },
    };
    expect(syncNotices(sync, catalog, tIn("en"), "en")).toEqual([
      "New achievement: Wanderer (Bronze)",
      "You earned 30 gems",
    ]);
    expect(
      syncNotices({ ...none, gems: { earned: 1, balance: 1 } }, catalog, tIn("en"), "en"),
    ).toEqual(["You earned 1 gem"]);
    expect(
      syncNotices({ ...none, gems: { earned: 2, balance: 2 } }, catalog, tIn("ar"), "ar"),
    ).toEqual(["حصلت على جوهرتين"]);
  });

  it("counts a sync that only paid gems as something written, and a balance alone as nothing", () => {
    expect(wroteSomething({ ...none, gems: { earned: 20, balance: 20 } })).toBe(true);
    expect(wroteSomething({ ...none, gems: { earned: 0, balance: 90 } })).toBe(false);
  });
});
