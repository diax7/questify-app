import { describe, expect, it } from "vitest";
import { blankQuest, questDraftOf, questProblem, type QuestView } from "#src/lib/quests.ts";

/** Pins every branch of `questProblem` and `questDraftOf` (inputs to outputs) so their split is provably neutral. */

const QUEST: QuestView = {
  id: "q1",
  categoryId: "c1",
  type: "enter_code",
  title: { ar: "الرمز", en: null },
  description: { ar: null, en: null },
  points: 15,
  repeatCap: 2,
  opensAt: "2030-11-01T07:00:00.000Z",
  closesAt: null,
  visible: true,
  position: 0,
  config: { code: "NAJD2030" },
  verification: [],
  itemId: "i1",
  place: null,
  pollSentAt: null,
};

const fine = { ...blankQuest("c1"), titleEn: "Find" };
const bonus = (change: object) => ({
  firstBonusOn: true,
  firstBonusPoints: 10,
  firstBonusSlots: 10,
  ...change,
});
const saved = (given: number) => ({
  points: 10,
  slots: 10,
  given,
  left: 10 - given,
  locked: true,
});
const passport = (list: unknown[], needed = 1, extra: object = {}) => ({
  type: "passport" as const,
  verification: [],
  config: { needed, steps: list },
  ...extra,
});
const named = { id: "a", text: { en: "A" } };
const arabic = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `${i}`, text: { ar: "أ" } }));
const LIVE = { options: [], live: { choices: "one", results: "never", minutes: 5 } };
const POLL = { type: "vote" as const, config: LIVE, verification: [] };
const LOCATION = { type: "location" as const };
const BAD_OPENS = { opensAt: "2030-11-01T10:00", closesAt: "2030-11-01T09:00" };
const MEET = (dailyCap: unknown, repeatCap: number, verification: string[] = []) => ({
  type: "meet" as const,
  config: { dailyCap },
  repeatCap,
  verification,
});

describe("questProblem branch table", () => {
  const table: [string, object, string | undefined][] = [
    ["a sound draft", {}, undefined],
    ["title: both names blank", { titleAr: " ", titleEn: "" }, "title"],
    ["only an Arabic title", { titleAr: "ع", titleEn: "" }, undefined],
    ["points: NaN", { points: Number.NaN }, "points"],
    ["points: negative", { points: -1 }, "points"],
    ["points: fractional", { points: 1.5 }, "points"],
    ["points: over the cap", { points: 100_001 }, "points"],
    ["zero points", { points: 0 }, undefined],
    ["the most points", { points: 100_000 }, undefined],
    ["closesAt: before opens", BAD_OPENS, "closesAt"],
    ["closesAt: equal to opens", { opensAt: "x", closesAt: "x" }, "closesAt"],
    [
      "closes after opens",
      { opensAt: "2030-11-01T10:00", closesAt: "2030-11-01T11:00" },
      undefined,
    ],
    ["only closesAt set", { closesAt: "2030-11-01T09:00" }, undefined],
    ["only opensAt set", { opensAt: "2030-11-01T09:00" }, undefined],
    ["place: location without a pin", LOCATION, "place"],
    ["place: half a pin", { placeLat: "24.7" }, "place"],
    ["a location with a pin", { ...LOCATION, placeLat: "24.7", placeLng: "46.6" }, undefined],
    [
      "a place on a type without one is not read",
      { type: "enter_code", config: { code: "NAJD2030" }, placeLat: "999", verification: [] },
      undefined,
    ],
    ["flash: a flash live poll", { flash: true, ...POLL }, "flash"],
    ["flashWindow: shown flash without times", { flash: true }, "flashWindow"],
    ["a hidden flash draft", { flash: true, visible: false }, undefined],
    ["a running flash needs no window", { flash: true, flashRunning: true }, undefined],
    [
      "a shown flash with a window",
      { flash: true, opensAt: "2030-11-01T10:00", closesAt: "2030-11-01T10:30" },
      undefined,
    ],
    ["firstBonus: points out of range", bonus({ firstBonusPoints: 0 }), "firstBonus"],
    ["firstBonus: slots out of range", bonus({ firstBonusSlots: 0 }), "firstBonus"],
    [
      "firstBonus: slots under those given",
      bonus({ firstBonusSlots: 3, firstBonusSaved: saved(4) }),
      "firstBonus",
    ],
    [
      "slots equal to those given",
      bonus({ firstBonusSlots: 4, firstBonusSaved: saved(4) }),
      undefined,
    ],
    ["a valid bonus", bonus({}), undefined],
    [
      "a bad bonus switched off",
      { firstBonusOn: false, firstBonusPoints: 0, firstBonusSlots: 0 },
      undefined,
    ],
    ["steps: none", passport([]), "steps"],
    ["steps: blank name", passport([{ id: "x", text: { ar: " ", en: "" } }]), "steps"],
    ["steps: one of two blank", passport([named, { id: "y", text: {} }]), "steps"],
    ["steps: too many", passport(arabic(31)), "steps"],
    [
      "steps: not an array count as none",
      passport([], 1, { config: { needed: 1, steps: "x" } }),
      "steps",
    ],
    ["the most steps", passport(arabic(30)), undefined],
    ["needed: more than the steps", passport([named], 2), "needed"],
    ["needed equals the steps", passport(arabic(2), 2), undefined],
    ["config: passport needed zero", passport([named], 0), "config"],
    [
      "config: invalid code",
      { type: "enter_code", config: { code: "AB" }, verification: [] },
      "config",
    ],
    [
      "a valid code",
      { type: "enter_code", config: { code: "NAJD2030" }, verification: [] },
      undefined,
    ],
    ["a meet without a daily cap", { ...MEET(undefined, 4), config: {} }, undefined],
    ["dailyCap: meet with zero", MEET(0, 4), "dailyCap"],
    ["dailyCap: over the repeat cap", MEET(5, 4), "dailyCap"],
    ["a meet cap equal to the repeat cap", MEET(4, 4), undefined],
    ["verification: scan with none", { verification: [] }, "verification"],
    ["verification: unknown method", { verification: ["nope"] }, "verification"],
    ["title beats points", { titleEn: "", points: -1 }, "title"],
    ["points beats closesAt", { points: -1, ...BAD_OPENS }, "points"],
    ["closesAt beats place", { ...BAD_OPENS, ...LOCATION }, "closesAt"],
    ["place beats flash", { ...LOCATION, flash: true }, "place"],
    ["flash beats flashWindow", { flash: true, ...POLL }, "flash"],
    ["flashWindow beats firstBonus", bonus({ flash: true, firstBonusPoints: 0 }), "flashWindow"],
    ["firstBonus beats steps", passport([], 1, bonus({ firstBonusPoints: 0 })), "firstBonus"],
    ["steps beats needed", passport([], 5), "steps"],
    ["steps beats config", passport([], 0), "steps"],
    [
      "config beats verification",
      { type: "enter_code", config: { code: "AB" }, verification: ["nope"] },
      "config",
    ],
    ["dailyCap beats verification", MEET(9, 1, ["nope"]), "dailyCap"],
  ];

  it.each(table)("%s", (_name, change, expected) => {
    expect(questProblem({ ...fine, ...change } as typeof fine)).toBe(expected);
  });
});

describe("questDraftOf branch table", () => {
  const zone = "Asia/Riyadh";
  const PAST = "2020-01-01T07:00:00.000Z";
  const FUTURE = "2099-01-01T07:00:00.000Z";
  const NO_BONUS = {
    firstBonusOn: false,
    firstBonusPoints: 10,
    firstBonusSlots: 10,
    firstBonusSaved: null,
  };

  it.each([
    ["no flash field", {}, { flash: false, flashRunning: false }],
    ["flash false", { flash: false, flashLaunchedAt: PAST }, { flash: false, flashRunning: false }],
    [
      "launched by hand",
      { flash: true, flashLaunchedAt: FUTURE, opensAt: FUTURE },
      { flash: true, flashRunning: true },
    ],
    ["shown and started", { flash: true, opensAt: PAST }, { flash: true, flashRunning: true }],
    [
      "shown, not yet started",
      { flash: true, opensAt: FUTURE },
      { flash: true, flashRunning: false },
    ],
    [
      "hidden though started",
      { flash: true, visible: false, opensAt: PAST },
      { flash: true, flashRunning: false },
    ],
    ["without an opening", { flash: true, opensAt: null }, { flash: true, flashRunning: false }],
    [
      "launchedAt null",
      { flash: true, flashLaunchedAt: null, opensAt: FUTURE },
      { flash: true, flashRunning: false },
    ],
  ])("flash: %s", (_name, change, expected) => {
    expect(questDraftOf({ ...QUEST, ...change } as QuestView, zone)).toMatchObject(expected);
  });

  it.each([
    ["no first bonus field", {}, NO_BONUS],
    ["first bonus null", { firstBonus: null }, NO_BONUS],
    [
      "first bonus set",
      { firstBonus: { points: 25, slots: 7, given: 2, left: 5, locked: true } },
      {
        firstBonusOn: true,
        firstBonusPoints: 25,
        firstBonusSlots: 7,
        firstBonusSaved: { points: 25, slots: 7, given: 2, left: 5, locked: true },
      },
    ],
  ])("first bonus: %s", (_name, change, expected) => {
    const draft = questDraftOf({ ...QUEST, ...change }, zone);
    expect(draft).toMatchObject(expected);
    expect(draft.firstBonusStop).toBe(false);
  });

  it("maps every field of a plain quest, null texts and item to empty strings", () => {
    expect(
      questDraftOf(
        {
          ...QUEST,
          title: { ar: null, en: "T" },
          description: { ar: "د", en: null },
          itemId: null,
          closesAt: "2030-11-01T08:30:00.000Z",
          visible: false,
        },
        zone,
      ),
    ).toEqual({
      type: "enter_code",
      categoryId: "c1",
      titleAr: "",
      titleEn: "T",
      descriptionAr: "د",
      descriptionEn: "",
      points: 15,
      repeatCap: 2,
      opensAt: "2030-11-01T10:00",
      closesAt: "2030-11-01T11:30",
      visible: false,
      config: { code: "NAJD2030" },
      verification: [],
      itemId: "",
      placeLat: "",
      placeLng: "",
      placeRadius: "100",
      pollSent: false,
      flash: false,
      flashRunning: false,
      ...NO_BONUS,
      firstBonusStop: false,
    });
  });

  it("holds a place, an item and a sent poll as typed text and flags", () => {
    expect(
      questDraftOf(
        { ...QUEST, itemId: "i9", place: { lat: 1.5, lng: -2, radiusM: 30 }, pollSentAt: PAST },
        zone,
      ),
    ).toMatchObject({
      itemId: "i9",
      placeLat: "1.5",
      placeLng: "-2",
      placeRadius: "30",
      pollSent: true,
    });
  });

  it("puts a passport's steps into its config, and leaves other configs alone", () => {
    const config = { needed: 1 };
    const step = { id: "s", name: { ar: null, en: null }, position: 0 };
    expect(
      questDraftOf({ ...QUEST, type: "passport", config, steps: [step] }, zone).config,
    ).toEqual({
      needed: 1,
      steps: [{ id: "s", saved: true, text: {} }],
    });
    expect(questDraftOf({ ...QUEST, type: "passport", config }, zone).config).toEqual({
      needed: 1,
      steps: [],
    });
    expect(questDraftOf({ ...QUEST, config, steps: [step] }, zone).config).toBe(config);
  });
});
