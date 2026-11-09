import { describe, expect, it } from "vitest";
import { blankGoal, goalBodyOf } from "#src/lib/community.ts";

const ZONE = "Asia/Riyadh";
const base = blankGoal(Date.parse("2030-01-01T07:00:00.000Z"), ZONE);

describe("goalBodyOf edges", () => {
  it("falls back to null for an empty quest or category and ignores both for points", () => {
    expect(
      goalBodyOf({ ...base, measure: "players", scope: "quest", questId: "" }, ZONE),
    ).toMatchObject({ questId: null, categoryId: null });
    expect(
      goalBodyOf({ ...base, measure: "players", scope: "category", categoryId: "" }, ZONE),
    ).toMatchObject({ questId: null, categoryId: null });
    expect(
      goalBodyOf({ ...base, measure: "players", scope: "category", categoryId: "c1" }, ZONE),
    ).toMatchObject({ questId: null, categoryId: "c1" });
    expect(
      goalBodyOf({ ...base, measure: "points", scope: "category", categoryId: "c9" }, ZONE),
    ).toMatchObject({ questId: null, categoryId: null });
    expect(
      goalBodyOf({ ...base, measure: "points", scope: "quest", questId: "q9" }, ZONE),
    ).toMatchObject({ questId: null, categoryId: null });
    expect(
      goalBodyOf(
        { ...base, measure: "completions", scope: "all", questId: "q1", categoryId: "c1" },
        ZONE,
      ),
    ).toMatchObject({ questId: null, categoryId: null });
  });

  it("keeps the stored window only for a started goal that has one", () => {
    const original = { startsAt: "2031-01-01T00:00:00.000Z", endsAt: "2031-02-01T00:00:00.000Z" };
    const typed = { ...base, startsAt: "2030-01-01T11:00", endsAt: "2030-01-02T11:00" };
    const fromTyped = {
      startsAt: "2030-01-01T08:00:00.000Z",
      endsAt: "2030-01-02T08:00:00.000Z",
    };
    expect(goalBodyOf({ ...typed, started: true }, ZONE, original)).toMatchObject(original);
    expect(goalBodyOf({ ...typed, started: false }, ZONE, original)).toMatchObject(fromTyped);
    expect(goalBodyOf({ ...typed, started: true }, ZONE)).toMatchObject(fromTyped);
  });
});
