import { describe, expect, it } from "vitest";
import {
  blankBoost,
  boostBodyOf,
  boostDraftOf,
  boostProblem,
  boostStateOf,
  boostsOf,
} from "#src/lib/boosts.ts";

const BOOST = {
  id: "b1",
  categoryId: "c1",
  category: { ar: null, en: "Stage" },
  multiplier: 2,
  startsAt: "2030-11-01T07:00:00.000Z",
  endsAt: "2030-11-01T07:30:00.000Z",
  rehearsal: false,
  editable: true,
  paid: 0,
};

describe("the Boosts page (T-307)", () => {
  it("reads the list, and refuses another shape", () => {
    expect(boostsOf({ boosts: [BOOST] })).toEqual([BOOST]);
    expect(boostsOf({ boosts: [{ ...BOOST, paid: "0" }] })).toBeUndefined();
    expect(boostsOf({})).toBeUndefined();
  });

  it("refuses a boost with any one field of the wrong type, and takes a null name", () => {
    const wrong: Record<string, unknown> = {
      id: 1,
      categoryId: null,
      category: { ar: 1, en: null },
      multiplier: "2",
      startsAt: 0,
      endsAt: null,
      rehearsal: "no",
      editable: 1,
      paid: null,
    };
    for (const [key, value] of Object.entries(wrong)) {
      expect(boostsOf({ boosts: [{ ...BOOST, [key]: value }] })).toBeUndefined();
    }
    expect(boostsOf({ boosts: [{ ...BOOST, category: { ar: null, en: "x" } }] })).toHaveLength(1);
    expect(boostsOf({ boosts: [{ ...BOOST, category: { ar: "س", en: null } }] })).toHaveLength(1);
    expect(boostsOf({ boosts: [{ ...BOOST, category: { ar: "س" } }] })).toBeUndefined();
    expect(boostsOf({ boosts: [{ ...BOOST, category: null }] })).toBeUndefined();
    expect(boostsOf({ boosts: [null] })).toBeUndefined();
    expect(boostsOf({ boosts: [] })).toEqual([]);
    expect(boostsOf({ boosts: "x" })).toBeUndefined();
    expect(boostsOf(null)).toBeUndefined();
  });

  it("says where a boost stands", () => {
    expect(boostStateOf(BOOST, Date.parse("2030-11-01T06:59:00Z"))).toBe("scheduled");
    expect(boostStateOf(BOOST, Date.parse("2030-11-01T07:00:00Z"))).toBe("running");
    expect(boostStateOf(BOOST, Date.parse("2030-11-01T07:30:00Z"))).toBe("ended");
  });

  it("sends now as null, a start read in the event's zone, and checks the fields first", () => {
    const now = blankBoost("c1");
    expect(boostBodyOf(now, "Asia/Riyadh")).toEqual({
      categoryId: "c1",
      startsAt: null,
      minutes: 30,
    });
    const later = boostDraftOf(BOOST, "Asia/Riyadh");
    expect(later).toEqual({
      id: "b1",
      categoryId: "c1",
      startNow: false,
      startsAt: "2030-11-01T10:00",
      minutes: 30,
    });
    expect(boostBodyOf(later, "Asia/Riyadh")).toEqual({
      categoryId: "c1",
      startsAt: "2030-11-01T07:00:00.000Z",
      minutes: 30,
    });
    expect(boostProblem(now)).toBeUndefined();
    expect(boostProblem({ ...now, categoryId: "" })).toBe("categoryId");
    expect(boostProblem({ ...now, startNow: false })).toBe("startsAt");
    expect(boostProblem({ ...now, minutes: 0 })).toBe("minutes");
    expect(boostProblem({ ...now, minutes: 1441 })).toBe("minutes");
  });
});
