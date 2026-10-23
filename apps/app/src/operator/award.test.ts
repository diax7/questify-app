import { describe, expect, it } from "vitest";
import {
  EMPTY_DRAFT,
  afterAward,
  amountOf,
  awardBody,
  awardFormOf,
  canAward,
  capProblem,
  foundPlayerOf,
  pointsOf,
  reasonOk,
  refusalSaid,
  type AwardDraft,
  type AwardForm,
  type FoundPlayer,
} from "#src/operator/award.ts";

const FORM: AwardForm = {
  capEach: 200,
  capDay: 500,
  leftToday: 450,
  live: true,
  quests: [{ id: "q1", title: { ar: "الكنز", en: "Treasure" }, points: 150 }],
};
const SARA: FoundPlayer = { enrollmentId: "e1", username: "Sara_88", avatar: "fox", active: true };
const FILLED: AwardDraft = { mode: "points", questId: null, points: "50", reason: "Helped out" };

describe("awardFormOf", () => {
  it("reads the caps, what is left, and the well-formed quests", () => {
    expect(
      awardFormOf({
        capEach: 200,
        capDay: 500,
        leftToday: 450,
        live: true,
        quests: [
          { id: "q1", title: { ar: "الكنز", en: "Treasure" }, points: 150 },
          { id: "q2", title: { en: "No points" } },
          { title: {}, points: 5 },
          "junk",
        ],
      }),
    ).toEqual(FORM);
  });

  it("reads a missing title as empty and anything but true as not live", () => {
    expect(
      awardFormOf({
        capEach: 1,
        capDay: 1,
        leftToday: 0,
        live: "yes",
        quests: [{ id: "q", title: null, points: 0 }],
      }),
    ).toEqual({
      capEach: 1,
      capDay: 1,
      leftToday: 0,
      live: false,
      quests: [{ id: "q", title: { ar: null, en: null }, points: 0 }],
    });
    expect(awardFormOf({ capEach: 1, capDay: 1, leftToday: 0 })?.quests).toEqual([]);
  });

  it("refuses a malformed form", () => {
    expect(awardFormOf(null)).toBeUndefined();
    expect(awardFormOf({ capDay: 1, leftToday: 1 })).toBeUndefined();
    expect(awardFormOf({ capEach: 1, leftToday: 1 })).toBeUndefined();
    expect(awardFormOf({ capEach: 1, capDay: 1 })).toBeUndefined();
    expect(awardFormOf({ capEach: -1, capDay: 1, leftToday: 1 })).toBeUndefined();
    expect(awardFormOf({ capEach: 1.5, capDay: 1, leftToday: 1 })).toBeUndefined();
  });
});

describe("foundPlayerOf", () => {
  it("reads the member, a miss, and a malformed answer", () => {
    expect(foundPlayerOf({ player: { ...SARA } })).toEqual(SARA);
    expect(foundPlayerOf({ player: { enrollmentId: "e1", username: "x" } })).toEqual({
      enrollmentId: "e1",
      username: "x",
      avatar: "",
      active: false,
    });
    expect(foundPlayerOf({ player: null })).toBeNull();
    expect(foundPlayerOf({})).toBeUndefined();
    expect(foundPlayerOf("x")).toBeUndefined();
    expect(foundPlayerOf({ player: { username: "x" } })).toBeUndefined();
    expect(foundPlayerOf({ player: { enrollmentId: "e1" } })).toBeUndefined();
  });
});

describe("pointsOf and reasonOk", () => {
  it("takes a whole number from 1 to 100000", () => {
    expect(pointsOf(" 50 ")).toBe(50);
    expect(pointsOf("1")).toBe(1);
    expect(pointsOf("100000")).toBe(100000);
    expect(pointsOf("100001")).toBeUndefined();
    expect(pointsOf("0")).toBeUndefined();
    expect(pointsOf("1234567")).toBeUndefined();
    expect(pointsOf("5.5")).toBeUndefined();
    expect(pointsOf("-5")).toBeUndefined();
    expect(pointsOf("٥٠")).toBeUndefined();
    expect(pointsOf("")).toBeUndefined();
  });

  it("wants a reason of 1 to 300 characters after trimming", () => {
    expect(reasonOk(" a ")).toBe(true);
    expect(reasonOk("   ")).toBe(false);
    expect(reasonOk("x".repeat(300))).toBe(true);
    expect(reasonOk("x".repeat(301))).toBe(false);
  });
});

describe("amountOf, capProblem and canAward", () => {
  it("takes the typed amount or the picked quest's points", () => {
    expect(amountOf(FILLED, FORM)).toBe(50);
    expect(amountOf({ ...FILLED, mode: "quest", questId: "q1" }, FORM)).toBe(150);
    expect(amountOf({ ...FILLED, mode: "quest", questId: null }, FORM)).toBeUndefined();
  });

  it("names the per-award cap first, then what is left today, each at its boundary", () => {
    expect(capProblem(200, FORM)).toBeUndefined();
    expect(capProblem(201, FORM)).toEqual({ key: "awards.overEach", params: { limit: "200" } });
    const low = { ...FORM, leftToday: 50 };
    expect(capProblem(50, low)).toBeUndefined();
    expect(capProblem(51, low)).toEqual({ key: "awards.overDay", params: { left: "50" } });
  });

  it("stays off until everything is filled, inside the caps, while live", () => {
    expect(canAward(SARA, FILLED, FORM)).toBe(true);
    expect(canAward(null, FILLED, FORM)).toBe(false);
    expect(canAward({ ...SARA, active: false }, FILLED, FORM)).toBe(false);
    expect(canAward(SARA, { ...FILLED, reason: " " }, FORM)).toBe(false);
    expect(canAward(SARA, { ...FILLED, points: "" }, FORM)).toBe(false);
    expect(canAward(SARA, { ...FILLED, points: "201" }, FORM)).toBe(false);
    expect(canAward(SARA, FILLED, { ...FORM, live: false })).toBe(false);
    expect(canAward(SARA, EMPTY_DRAFT, FORM)).toBe(false);
  });
});

describe("awardBody and afterAward", () => {
  it("sends exactly one of a quest or an amount, with the trimmed reason", () => {
    expect(awardBody("ev", SARA, { ...FILLED, reason: " Helped " })).toEqual({
      eventId: "ev",
      enrollmentId: "e1",
      points: 50,
      reason: "Helped",
    });
    expect(awardBody("ev", SARA, { ...FILLED, mode: "quest", questId: "q1" })).toEqual({
      eventId: "ev",
      enrollmentId: "e1",
      questId: "q1",
      reason: "Helped out",
    });
  });

  it("lowers what is left today, never below zero", () => {
    expect(afterAward(FORM, 50).leftToday).toBe(400);
    expect(afterAward(FORM, 999).leftToday).toBe(0);
  });
});

describe("refusalSaid", () => {
  it("names the cap an over-cap refusal crossed", () => {
    expect(refusalSaid("over_cap", { cap: "each", limit: 200, left: 450 })).toEqual({
      key: "awards.overEach",
      params: { limit: "200" },
    });
    expect(refusalSaid("over_cap", { cap: "day", limit: 500, left: 50 })).toEqual({
      key: "awards.overDay",
      params: { left: "50" },
    });
  });

  it("says to wait after too many finds", () => {
    expect(refusalSaid("too_many_attempts", {})).toEqual({
      key: "operator.award.tooMany",
      params: {},
    });
  });

  it("leaves any other refusal, and a malformed over-cap one, to the API's message", () => {
    expect(refusalSaid("self_award", {})).toBeUndefined();
    expect(refusalSaid("over_cap", {})).toBeUndefined();
    expect(refusalSaid("over_cap", { cap: "day" })).toBeUndefined();
    expect(refusalSaid("over_cap", { cap: "day", limit: 5 })).toBeUndefined();
    expect(refusalSaid("over_cap", { cap: "each", left: 5 })).toBeUndefined();
  });
});
