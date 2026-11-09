import {
  DEFAULT_TERMS,
  MESSAGES,
  createTranslator,
  type Language,
  type MessageKey,
} from "@questify/shared";
import { describe, expect, it } from "vitest";
import { bonusLine, headlineText, itemLine } from "#src/event/amount.ts";
import { celebrationBeats, type ScanStep } from "#src/event/celebration.ts";
import { beatViewOf, hasNextBeat, pointsLines } from "#src/event/celebration-view.ts";
import { firstBonusLine } from "#src/event/first-bonus.ts";
import type { Category, Quest } from "#src/event/quests-api.ts";
import { textIn } from "#src/i18n/text.ts";

type Celebrating = Extract<ScanStep, { kind: "celebrating" }>;

const translate = createTranslator(MESSAGES);
const tIn =
  (language: Language) => (key: MessageKey, params?: Readonly<Record<string, string | number>>) =>
    translate(key, language, params);

const TERMS = {
  ...DEFAULT_TERMS,
  currency: {
    icon: "gem" as const,
    ar: { one: "جوهرة", many: "جواهر" },
    en: { one: "gem", many: "gems" },
  },
};

const quest = { id: "q1", title: { ar: "المهمة", en: "The quest" } } as unknown as Quest;
const category = {
  id: "c1",
  name: { ar: "المرحلة", en: "Stage" },
  quests: [],
} as unknown as Category;
const BONUS = { points: 50, category: { ar: "المرحلة", en: "Stage" }, item: null };
const ITEM = { name: { ar: "قميص", en: "T-shirt" }, outcome: "out_of_stock" as const, until: null };
const WON = { points: 20, place: 2, slots: 5 };
const MISSED = { points: 20, place: null, slots: 5 };
const STREAK = { points: 25, days: 3 };
const LEVEL = { level: 4, title: { ar: "مغامر", en: "Adventurer" } };

const step = (fields: Partial<Celebrating> = {}): Celebrating => ({
  kind: "celebrating",
  questId: "q1",
  points: 10,
  replayed: false,
  levelUp: null,
  bonus: null,
  item: null,
  boosted: false,
  firstBonus: null,
  streakBonus: null,
  met: null,
  details: undefined,
  ...fields,
});

// The beat choice exactly as Celebration held it inline: the first `if` whose beat and data both match wins.
function oldBeat(s: Celebrating, shown: number): string {
  const beat = celebrationBeats(s)[shown] ?? "points";
  const cat = s.details?.finishedCategory;
  if (beat === "category" && cat !== undefined) {
    return "category";
  }
  if (beat === "firstBonus" && s.firstBonus !== null) {
    return "firstBonus";
  }
  if (beat === "streak" && s.streakBonus !== null) {
    return "streak";
  }
  if (beat === "level" && s.levelUp !== null) {
    return "level";
  }
  return "points";
}

// The points beat's lines exactly as Celebration's JSX held them: [variant, text] in render order.
function oldLines(language: Language, s: Celebrating): [string, string][] {
  const t = tIn(language);
  const out: [string, string][] = [
    ["display", headlineText(t, s.details?.otherEvent ? DEFAULT_TERMS : TERMS, language, s)],
  ];
  if (s.boosted) {
    out.push(["title", t("completion.boosted")]);
  }
  if (s.met !== null) {
    out.push(["title", t("meet.youMet", { name: s.met })]);
  }
  if (s.item !== null) {
    out.push(["title", itemLine(t, language, s.item)]);
  }
  if (s.bonus !== null) {
    out.push(["title", bonusLine(t, language, s.bonus)]);
  }
  if (!(s.firstBonus === null || s.firstBonus.place !== null)) {
    out.push(["", firstBonusLine(t, language, s.firstBonus)]);
  }
  if (s.details?.quest !== undefined) {
    out.push(["title", textIn(s.details.quest.title, language)]);
  }
  if (s.details?.otherEvent) {
    out.push(["", t("scanner.otherEvent")]);
  }
  return out;
}

const both = (details: Celebrating["details"]) => details;
const yes = <T>(value: T): (T | null)[] => [null, value];

describe("beatViewOf", () => {
  const full = step({
    firstBonus: WON,
    streakBonus: STREAK,
    levelUp: LEVEL,
    details: { quest, finishedCategory: category, otherEvent: false },
  });

  it.each<[string, Celebrating, number, string]>([
    ["points first", full, 0, "points"],
    ["a first-N bonus won", full, 1, "firstBonus"],
    ["a streak bonus", full, 2, "streak"],
    ["a level-up", full, 3, "level"],
    ["a finished category", full, 4, "category"],
    ["past the last beat", full, 5, "points"],
    ["a missed first-N bonus has no beat", step({ firstBonus: MISSED }), 1, "points"],
    ["a plain scan", step(), 0, "points"],
    ["claim waits for the quests: no category yet", step({ levelUp: LEVEL }), 1, "level"],
    [
      "a category with no first-N bonus comes after the level",
      step({
        levelUp: LEVEL,
        details: { quest, finishedCategory: category, otherEvent: false },
      }),
      2,
      "category",
    ],
  ])("%s", (_name, s, shown, kind) => {
    expect(beatViewOf(s, shown).kind).toBe(kind);
    expect(oldBeat(s, shown)).toBe(kind);
  });

  it("carries the data of the beat it names", () => {
    expect(beatViewOf(full, 1)).toEqual({ kind: "firstBonus", bonus: WON });
    expect(beatViewOf(full, 2)).toEqual({ kind: "streak", bonus: STREAK });
    expect(beatViewOf(full, 3)).toEqual({ kind: "level", levelUp: LEVEL });
    expect(beatViewOf(full, 4)).toEqual({ kind: "category", category });
  });

  it("matches the old inline choice for every combination of data and beat", () => {
    for (const firstBonus of [null, WON, MISSED]) {
      for (const streakBonus of [null, STREAK]) {
        for (const levelUp of [null, LEVEL]) {
          for (const details of [
            undefined,
            { quest, finishedCategory: undefined, otherEvent: false },
            { quest, finishedCategory: category, otherEvent: false },
          ]) {
            const s = step({ firstBonus, streakBonus, levelUp, details });
            for (let shown = 0; shown < 7; shown += 1) {
              expect(beatViewOf(s, shown).kind).toBe(oldBeat(s, shown));
            }
          }
        }
      }
    }
  });
});

describe("hasNextBeat", () => {
  it.each<[string, Celebrating, number, boolean]>([
    ["only the points: Claim closes", step(), 0, false],
    ["a level-up follows the points", step({ levelUp: LEVEL }), 0, true],
    ["on the last beat Claim closes", step({ levelUp: LEVEL }), 1, false],
    ["a missed first-N bonus adds no beat", step({ firstBonus: MISSED }), 0, false],
    ["a won first-N bonus adds one", step({ firstBonus: WON }), 0, true],
    [
      "the category beat arrives with the details",
      step({ details: { quest, finishedCategory: category, otherEvent: false } }),
      0,
      true,
    ],
  ])("%s", (_name, s, shown, next) => {
    expect(hasNextBeat(s, shown)).toBe(next);
    // The old claim: `shown + 1 < beats.length ? setShown(shown + 1) : onClaim()`.
    expect(shown + 1 < celebrationBeats(s).length).toBe(next);
  });
});

describe("pointsLines", () => {
  it("is the headline alone for a plain scan, with the event's own currency", () => {
    const lines = pointsLines(tIn("en"), TERMS, "en", step({ points: 10 }));
    expect(lines).toEqual([{ key: "headline", text: "+10 gems", props: { variant: "display" } }]);
  });

  it("says a replay that paid nothing as already recorded", () => {
    const lines = pointsLines(tIn("en"), TERMS, "en", step({ points: 0, replayed: true }));
    expect(lines.map((line) => line.text)).toEqual(["Already recorded"]);
  });

  it("uses Questify's words for a code paid in another event, and says so", () => {
    const s = step({
      details: { quest: undefined, finishedCategory: undefined, otherEvent: true },
    });
    const lines = pointsLines(tIn("en"), TERMS, "en", s);
    expect(lines.map((line) => [line.key, line.props.variant ?? ""])).toEqual([
      ["headline", "display"],
      ["otherEvent", ""],
    ]);
    expect(lines[0]?.text).toBe(headlineText(tIn("en"), DEFAULT_TERMS, "en", s));
    expect(lines[0]?.text).not.toBe(headlineText(tIn("en"), TERMS, "en", s));
  });

  it("lists every line in the order the screen shows them", () => {
    const s = step({
      boosted: true,
      met: "sara",
      item: ITEM,
      bonus: BONUS,
      firstBonus: MISSED,
      details: { quest, finishedCategory: undefined, otherEvent: true },
    });
    const lines = pointsLines(tIn("en"), TERMS, "en", s);
    expect(lines.map((line) => [line.key, line.props.variant ?? ""])).toEqual([
      ["headline", "display"],
      ["boosted", "title"],
      ["met", "title"],
      ["item", "title"],
      ["bonus", "title"],
      ["firstBonusMissed", ""],
      ["quest", "title"],
      ["otherEvent", ""],
    ]);
    expect(lines.map((line) => line.text)).toEqual([
      "+10 points",
      "Double points!",
      "You met @sara",
      "The T-shirt ran out; you got the points",
      "+50 bonus: Stage complete",
      firstBonusLine(tIn("en"), "en", MISSED),
      "The quest",
      "This code counted in another of your events.",
    ]);
  });

  it("shows a won first-N bonus only as its own beat, not among the points lines", () => {
    const lines = pointsLines(tIn("en"), TERMS, "en", step({ firstBonus: WON }));
    expect(lines.map((line) => line.key)).toEqual(["headline"]);
  });

  it("matches the old inline lines for every combination, in both languages", () => {
    for (const language of ["ar", "en"] as const) {
      for (const boosted of [false, true]) {
        for (const met of yes("sara")) {
          for (const item of yes(ITEM)) {
            for (const bonus of yes(BONUS)) {
              for (const firstBonus of [null, WON, MISSED]) {
                for (const details of [
                  undefined,
                  both({ quest: undefined, finishedCategory: undefined, otherEvent: false }),
                  both({ quest, finishedCategory: undefined, otherEvent: false }),
                  both({ quest: undefined, finishedCategory: undefined, otherEvent: true }),
                  both({ quest, finishedCategory: category, otherEvent: true }),
                ]) {
                  for (const [points, replayed] of [
                    [10, false],
                    [0, true],
                  ] as const) {
                    const s = step({
                      boosted,
                      met,
                      item,
                      bonus,
                      firstBonus,
                      details,
                      points,
                      replayed,
                    });
                    const lines = pointsLines(tIn(language), TERMS, language, s);
                    expect(lines.map((line) => [line.props.variant ?? "", line.text])).toEqual(
                      oldLines(language, s),
                    );
                    expect(new Set(lines.map((line) => line.key)).size).toBe(lines.length);
                  }
                }
              }
            }
          }
        }
      }
    }
  });
});
