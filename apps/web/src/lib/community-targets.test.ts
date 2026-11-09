import { describe, expect, it } from "vitest";
import { targetChoices, type UnlockOptions } from "#src/lib/community.ts";

const options: UnlockOptions = {
  quests: [
    { id: "q1", name: "Tower", categoryId: "c1", livePoll: false },
    { id: "q2", name: "Poll", categoryId: "c1", livePoll: true },
    { id: "q3", name: "Lantern walk", categoryId: "c2", livePoll: false },
  ],
  categories: [
    { id: "c1", name: "Stage" },
    { id: "c2", name: "Garden" },
  ],
  rewards: [{ id: "r1", name: "Hoodie" }],
};
const none: ReadonlySet<string> = new Set();

describe("targetChoices edges", () => {
  it("excludes nothing the goal counts when every quest counts", () => {
    const draft = {
      measure: "completions" as const,
      scope: "all" as const,
      questId: "q1",
      categoryId: "c1",
    };
    expect(targetChoices("quest", options, draft, none)).toEqual([
      { id: "q1", name: "Tower", taken: false },
      { id: "q3", name: "Lantern walk", taken: false },
    ]);
    expect(targetChoices("category", options, draft, none).map((choice) => choice.id)).toEqual([
      "c1",
      "c2",
    ]);
  });

  it("excludes the counted quest and its category, and marks taken targets", () => {
    const draft = {
      measure: "completions" as const,
      scope: "quest" as const,
      questId: "q3",
      categoryId: "",
    };
    const taken = new Set(["quest:q1", "category:c1", "reward:r1"]);
    expect(targetChoices("quest", options, draft, taken)).toEqual([
      { id: "q1", name: "Tower", taken: true },
    ]);
    expect(targetChoices("category", options, draft, taken)).toEqual([
      { id: "c1", name: "Stage", taken: true },
    ]);
    expect(targetChoices("reward", options, draft, taken)).toEqual([
      { id: "r1", name: "Hoodie", taken: true },
    ]);
  });

  it("excludes no category when the counted quest is unknown", () => {
    const draft = {
      measure: "completions" as const,
      scope: "quest" as const,
      questId: "gone",
      categoryId: "c2",
    };
    expect(targetChoices("category", options, draft, none).map((choice) => choice.id)).toEqual([
      "c1",
      "c2",
    ]);
  });

  it("excludes nothing when the goal counts points, whatever scope and ids the draft holds", () => {
    const draft = {
      measure: "points" as const,
      scope: "quest" as const,
      questId: "q3",
      categoryId: "c1",
    };
    expect(targetChoices("quest", options, draft, none).map((choice) => choice.id)).toEqual([
      "q1",
      "q3",
    ]);
    expect(targetChoices("category", options, draft, none).map((choice) => choice.id)).toEqual([
      "c1",
      "c2",
    ]);
  });

  it("keeps the counted category's quests but not the category itself", () => {
    const draft = {
      measure: "completions" as const,
      scope: "category" as const,
      questId: "q1",
      categoryId: "c1",
    };
    expect(targetChoices("quest", options, draft, none).map((choice) => choice.id)).toEqual([
      "q1",
      "q3",
    ]);
    expect(targetChoices("category", options, draft, none).map((choice) => choice.id)).toEqual([
      "c2",
    ]);
  });
});
