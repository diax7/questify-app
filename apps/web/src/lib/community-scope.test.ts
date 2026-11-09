import { describe, expect, it } from "vitest";
import { scopePickOf, withScopePick } from "#src/lib/community.ts";

const draft = {
  measure: "completions" as const,
  scope: "quest" as const,
  questId: "q-1",
  categoryId: "c-1",
};

describe("scopePickOf", () => {
  it("has no picker for points, whatever the scope says", () => {
    expect(scopePickOf({ ...draft, measure: "points" })).toBeNull();
    expect(scopePickOf({ ...draft, measure: "points", scope: "all" })).toBeNull();
  });

  it("has no picker when every quest counts", () => {
    expect(scopePickOf({ ...draft, scope: "all" })).toBeNull();
  });

  it("picks the quest or the category by scope", () => {
    expect(scopePickOf(draft)).toEqual({ scope: "quest", value: "q-1" });
    expect(scopePickOf({ ...draft, measure: "players", scope: "category" })).toEqual({
      scope: "category",
      value: "c-1",
    });
  });
});

describe("withScopePick", () => {
  it("sets the quest for the quest scope and leaves the category", () => {
    expect(withScopePick(draft, "quest", "q-2")).toEqual({ ...draft, questId: "q-2" });
  });

  it("sets the category for the category scope and leaves the quest", () => {
    expect(withScopePick(draft, "category", "c-2")).toEqual({ ...draft, categoryId: "c-2" });
  });
});
