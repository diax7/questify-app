import { MESSAGES, createTranslator, type Language } from "@questify/shared";
import { describe, expect, it } from "vitest";
import { paidText } from "#src/event/amount.ts";
import { celebrationBeats, scanStep, type ScanStep } from "#src/event/celebration.ts";
import {
  firstBonusLine,
  firstBonusPaidOf,
  liveFirstBonusOf,
  questFirstBonusOf,
  ribbonLines,
  withLiveLeft,
} from "#src/event/first-bonus.ts";
import { fetchLive, liveStateOf } from "#src/event/polls.ts";
import { DEFAULT_TERMS } from "@questify/shared";
import { stationResult } from "#src/operator/station.ts";

const translate = createTranslator(MESSAGES);
const tIn =
  (language: Language) =>
  (key: keyof typeof MESSAGES, params?: Readonly<Record<string, string | number>>) =>
    translate(key, language, params);
const OPEN = { points: 25, slots: 50, left: 12, mine: null };

describe("the first-N bonus's reads (T-313)", () => {
  it("reads the quests read's bonus, and none for a missing or malformed one", () => {
    expect(questFirstBonusOf(OPEN)).toEqual(OPEN);
    expect(questFirstBonusOf({ ...OPEN, mine: { place: 3 } })).toEqual({
      ...OPEN,
      mine: { place: 3 },
    });
    expect(questFirstBonusOf({ ...OPEN, mine: { place: "3" } })?.mine).toBeNull();
    for (const bad of [null, undefined, "x", { ...OPEN, left: -1 }, { ...OPEN, slots: 1.5 }]) {
      expect(questFirstBonusOf(bad)).toBeNull();
    }
  });

  it("reads a completion's bonus, won or all taken, and none for anything else", () => {
    expect(firstBonusPaidOf({ points: 25, place: 3, slots: 50 })).toEqual({
      points: 25,
      place: 3,
      slots: 50,
    });
    expect(firstBonusPaidOf({ points: 25, place: null, slots: 50 })?.place).toBeNull();
    expect(firstBonusPaidOf({ points: 25, slots: 50 })).toBeNull();
    expect(firstBonusPaidOf(null)).toBeNull();
  });

  it("reads the live bonuses, dropping malformed ones, and none from an older API", () => {
    expect(
      liveFirstBonusOf([
        { questId: "q1", left: 0, slots: 5 },
        { questId: "q2", left: "1", slots: 5 },
        "x",
      ]),
    ).toEqual([{ questId: "q1", left: 0, slots: 5 }]);
    expect(liveFirstBonusOf(undefined)).toEqual([]);
    expect(liveStateOf({ polls: [], closed: [] })?.firstBonus).toEqual([]);
    expect(
      liveStateOf({ polls: [], closed: [], firstBonus: [{ questId: "q1", left: 3, slots: 5 }] })
        ?.firstBonus,
    ).toEqual([{ questId: "q1", left: 3, slots: 5 }]);
  });
});

describe("the ribbon follows /live (CTO MAJOR 3)", () => {
  it("takes what is left from /live, keeps the quests read's count for a quest /live does not name", () => {
    const live = [{ questId: "q1", left: 0, slots: 40 }];
    expect(withLiveLeft(OPEN, "q1", live)).toEqual({ ...OPEN, left: 0, slots: 40 });
    expect(withLiveLeft(OPEN, "q2", live)).toEqual(OPEN);
    expect(withLiveLeft(null, "q1", live)).toBeNull();
    const mine = { ...OPEN, mine: { place: 2 } };
    expect(withLiveLeft(mine, "q1", live)).toEqual(mine);
  });

  it("reads only /live when what is left changes: never the quests", async () => {
    const asked: unknown[] = [];
    let left = 4;
    const session = {
      request: async (request: unknown) => {
        asked.push(request);
        return {
          kind: "ok",
          status: 200,
          body: { polls: [], closed: [], firstBonus: [{ questId: "q1", left, slots: 5 }] },
          headers: new Headers({}),
        } as never;
      },
    };
    const first = await fetchLive(session, "e1", null);
    left = 3;
    const second = await fetchLive(session, "e1", null);
    expect(first.kind === "state" ? first.state.firstBonus[0]?.left : undefined).toBe(4);
    expect(second.kind === "state" ? second.state.firstBonus[0]?.left : undefined).toBe(3);
    expect(asked).toEqual([
      { method: "GET", path: "/v1/events/e1/live" },
      { method: "GET", path: "/v1/events/e1/live" },
    ]);
  });
});

describe("the bonus in words, both languages, Western digits", () => {
  it("says the ribbon's three states", () => {
    expect(ribbonLines(OPEN, tIn("en"), "en")).toEqual({
      title: "First 50",
      detail: "+25 · 12 left",
    });
    expect(ribbonLines({ ...OPEN, left: 0 }, tIn("en"), "en").detail).toBe("All taken");
    expect(ribbonLines({ ...OPEN, mine: { place: 3 } }, tIn("en"), "en").detail).toBe(
      "You got bonus #3",
    );
    expect(ribbonLines(OPEN, tIn("ar"), "ar")).toEqual({
      title: "أول 50",
      detail: "‎+25 · بقي 12",
    });
    expect(ribbonLines({ ...OPEN, left: 0 }, tIn("ar"), "ar").detail).toBe("نفدت");
    expect(ribbonLines({ ...OPEN, mine: { place: 3 } }, tIn("ar"), "ar").detail).toBe(
      "حصلت على المكافأة رقم 3",
    );
  });

  it("says the success card's won and missed lines, and adds them to what a play paid", () => {
    const won = { points: 25, place: 1, slots: 50 };
    expect(firstBonusLine(tIn("en"), "en", won)).toBe("First 50 bonus! +25");
    expect(firstBonusLine(tIn("en"), "en", { ...won, place: null })).toBe(
      "The first-50 bonus is all taken",
    );
    expect(firstBonusLine(tIn("ar"), "ar", won)).toBe("مكافأة أول 50! ‎+25");
    expect(firstBonusLine(tIn("ar"), "ar", { ...won, place: null })).toBe("نفدت مكافأة أول 50");
    expect(
      paidText(tIn("en"), DEFAULT_TERMS, "en", {
        points: 10,
        bonus: null,
        item: null,
        firstBonus: won,
      }),
    ).toMatch(/First 50 bonus! \+25$/);
  });

  it("gives a won bonus its own beat after the points, and a missed one none", () => {
    const checking: ScanStep = { kind: "checking", questId: "q1", token: "t" };
    const paid = (place: number | null) =>
      scanStep(checking, {
        type: "answered",
        answer: {
          kind: "completed",
          points: 10,
          score: 35,
          replayed: false,
          levelUp: null,
          bonus: null,
          item: null,
          boost: null,
          firstBonus: { points: 25, place, slots: 50 },
        },
      }) as Extract<ScanStep, { kind: "celebrating" }>;
    expect(celebrationBeats(paid(1))).toEqual(["points", "firstBonus"]);
    expect(celebrationBeats(paid(null))).toEqual(["points"]);
  });

  it("tells a practice scan the bonus it would also earn", () => {
    expect(stationResult({ result: "completed", points: 10, bonusPoints: 25 })).toMatchObject({
      color: "green",
      bonusPoints: 25,
    });
    expect(stationResult({ result: "completed", points: 10 })).toMatchObject({ bonusPoints: null });
    expect(tIn("ar")("operator.practice.firstBonus", { points: 25 })).toContain("25");
  });
});
