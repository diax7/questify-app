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
