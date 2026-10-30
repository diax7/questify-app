import { describe, expect, it } from "vitest";
import type { Goal } from "#src/lib/community.ts";
import {
  finaleBodyOf,
  finaleDraftOf,
  finaleReadingOf,
  invalidKeyOf,
  pushGoalsOf,
  resultsKeyOf,
  type FinaleReading,
} from "#src/lib/finale.ts";

const reading = (body: object): FinaleReading => {
  const read = finaleReadingOf(body);
  if (read === undefined) {
    throw new Error("not a reading");
  }
  return read;
};
const goal = (id: string, finalAt: string | null): Goal => ({ id, finalAt }) as Goal;

describe("reading the finale", () => {
  it("reads the finale with its goal title, and no finale", () => {
    expect(
      reading({
        enabled: true,
        endsAt: "2026-10-30T21:00:00.000Z",
        state: "open",
        finale: {
          startsAt: "2026-10-30T20:00:00.000Z",
          started: false,
          goalId: "g1",
          goal: { title: { en: "Light the tower" }, status: "running" },
        },
      }),
    ).toEqual({
      enabled: true,
      endsAt: "2026-10-30T21:00:00.000Z",
      state: "open",
      finale: {
        startsAt: "2026-10-30T20:00:00.000Z",
        started: false,
        goalId: "g1",
        goalTitle: { ar: null, en: "Light the tower" },
      },
    });
    expect(reading({ enabled: false, state: "not_ended", finale: null })).toEqual({
      enabled: false,
      endsAt: null,
      state: "not_ended",
      finale: null,
    });
  });

  it("refuses an answer that is not one", () => {
    expect(finaleReadingOf(undefined)).toBeUndefined();
    expect(finaleReadingOf({ state: "someday" })).toBeUndefined();
    expect(reading({ state: "revealed", finale: { startsAt: 5 } }).finale).toBeNull();
  });
});

describe("the form", () => {
  const zone = "Asia/Riyadh";

  it("starts an hour ahead with no last push, and shows a saved finale as saved", () => {
    const none = reading({ enabled: true, state: "not_ended", finale: null });
    expect(finaleDraftOf(none, zone, Date.parse("2026-10-30T10:00:00.000Z"))).toEqual({
      startsAt: "2026-10-30T14:00",
      goalId: "",
    });
    const saved = reading({
      enabled: true,
      state: "not_ended",
      finale: { startsAt: "2026-10-30T17:00:00.000Z", goalId: "g1" },
    });
    expect(finaleDraftOf(saved, zone, 0)).toEqual({ startsAt: "2026-10-30T20:00", goalId: "g1" });
  });

  it("sends the wall-clock time as an instant in the event zone, and no goal as null", () => {
    expect(finaleBodyOf({ startsAt: "2026-10-30T20:00", goalId: "" }, zone)).toEqual({
      startsAt: "2026-10-30T17:00:00.000Z",
      goalId: null,
    });
    expect(finaleBodyOf({ startsAt: "2026-10-30T20:00", goalId: "g1" }, zone)?.goalId).toBe("g1");
    expect(finaleBodyOf({ startsAt: "", goalId: "" }, zone)).toBeUndefined();
    expect(finaleBodyOf({ startsAt: "2026-02-30T20:00", goalId: "" }, zone)).toBeUndefined();
  });

  it("offers the goals still open, and keeps the saved one in the list", () => {
    const goals = [goal("a", null), goal("b", "2026-10-30T10:00:00.000Z"), goal("c", null)];
    expect(pushGoalsOf(goals, null).map((item) => item.id)).toEqual(["a", "c"]);
    expect(pushGoalsOf(goals, "b").map((item) => item.id)).toEqual(["a", "b", "c"]);
  });

  it("words each refusal and falls back to the time line", () => {
    expect(invalidKeyOf("goal_window")).toBe("finale.invalid.goalWindow");
    expect(invalidKeyOf("goal_done")).toBe("finale.invalid.goalDone");
    expect(invalidKeyOf("goal")).toBe("finale.invalid.goal");
    expect(invalidKeyOf("elsewhere")).toBe("finale.invalid.startsAt");
    expect(invalidKeyOf(undefined)).toBe("finale.invalid.startsAt");
  });

  it("says what to do next about the winners in each state", () => {
    expect(resultsKeyOf("not_ended")).toBe("finale.results.notEnded");
    expect(resultsKeyOf("open")).toBe("finale.results.open");
    expect(resultsKeyOf("confirmed")).toBe("finale.results.confirmed");
    expect(resultsKeyOf("revealed")).toBe("finale.results.revealed");
  });
});
