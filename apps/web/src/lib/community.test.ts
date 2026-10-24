import { describe, expect, it } from "vitest";
import {
  blankGoal,
  blankReward,
  goalBodyOf,
  goalDraftOf,
  goalsOf,
  isLive,
  issuesOf,
  previewFills,
  settleAnswerOf,
  takenTargets,
  targetChoices,
  type Goal,
} from "#src/lib/community.ts";

const ZONE = "Asia/Riyadh";
const goal: Goal = {
  id: "g1",
  title: { ar: "أضيئوا البرج", en: "Light the tower" },
  measure: "completions",
  questId: null,
  categoryId: "c1",
  target: 200,
  startsAt: "2030-01-01T07:00:00.000Z",
  endsAt: "2030-01-01T08:00:00.000Z",
  closesAt: "2030-01-01T08:00:00.000Z",
  paidTo: "everyone",
  status: "running",
  progress: 50,
  finalAt: null,
  started: true,
  steps: [
    {
      threshold: 50,
      isGoal: false,
      reward: { kind: "moment", points: null, moment: { ar: null, en: "Drums" }, unlock: null },
      reachedAt: "2030-01-01T07:30:00.000Z",
      due: 0,
      paid: 0,
      skipped: 0,
    },
    {
      threshold: 200,
      isGoal: true,
      reward: { kind: "points", points: 20, moment: null, unlock: null },
      reachedAt: null,
      due: 0,
      paid: 0,
      skipped: 0,
    },
  ],
};

describe("community goals on the dashboard (T-306b)", () => {
  it("starts a new goal in 10 minutes for an hour, in the event's zone", () => {
    const draft = blankGoal(Date.parse("2030-01-01T07:00:00.000Z"), ZONE);
    expect([draft.startsAt, draft.endsAt]).toEqual(["2030-01-01T10:10", "2030-01-01T11:10"]);
    expect(draft).toMatchObject({
      measure: "points",
      scope: "all",
      paidTo: "contributors",
      milestones: [],
    });
  });

  it("reads a goal into the form and back into the same body", () => {
    const draft = goalDraftOf(goal, ZONE);
    expect(draft).toMatchObject({
      scope: "category",
      categoryId: "c1",
      target: "200",
      startsAt: "2030-01-01T10:00",
      reward: { kind: "points", points: "20" },
      milestones: [{ threshold: "50", kind: "moment", momentEn: "Drums", momentAr: "" }],
    });
    expect(goalBodyOf(draft, ZONE, goal)).toEqual({
      title: { ar: "أضيئوا البرج", en: "Light the tower" },
      measure: "completions",
      questId: null,
      categoryId: "c1",
      target: 200,
      startsAt: goal.startsAt,
      endsAt: goal.endsAt,
      paidTo: "everyone",
      reward: { kind: "points", points: 20 },
      milestones: [
        { threshold: 50, reward: { kind: "moment", moment: { ar: undefined, en: "Drums" } } },
      ],
    });
  });

  it("sends the typed window before the start, no quest or category for points, and NaN for a bad number", () => {
    const draft = {
      ...goalDraftOf(goal, ZONE),
      started: false,
      startsAt: "2030-01-01T11:00",
      target: "2x",
    };
    const body = goalBodyOf(draft, ZONE, goal);
    expect(body["startsAt"]).toBe("2030-01-01T08:00:00.000Z");
    expect(body["target"]).toBeNaN();
    const points = goalBodyOf(
      {
        ...draft,
        measure: "points",
        reward: { ...blankReward(), kind: "nothing" },
      },
      ZONE,
    );
    expect([points["questId"], points["categoryId"], points["reward"]]).toEqual([
      null,
      null,
      { kind: "nothing" },
    ]);
    const quest = goalBodyOf({ ...draft, scope: "quest", questId: "q1" }, ZONE);
    expect([quest["questId"], quest["categoryId"]]).toEqual(["q1", null]);
  });

  it("previews the bar empty and at the first milestone", () => {
    expect(previewFills({ target: "200", milestones: [] })).toEqual([0]);
    expect(previewFills(goalDraftOf(goal, ZONE))).toEqual([0, 0.25]);
    expect(previewFills({ target: "", milestones: goalDraftOf(goal, ZONE).milestones })).toEqual([
      0,
    ]);
    expect(previewFills({ target: "40", milestones: goalDraftOf(goal, ZONE).milestones })).toEqual([
      0,
    ]);
  });

  it("reads the answers: goals, issues, the settle and whether a goal is live", () => {
    expect(goalsOf({ goals: [goal] })).toEqual([goal]);
    expect(goalsOf({})).toBeUndefined();
    expect(issuesOf({ details: { issues: ["target", 3] } })).toEqual(["target"]);
    expect(issuesOf({})).toEqual([]);
    expect(settleAnswerOf({ status: "paying", goals: 0, due: 3 })).toEqual({
      status: "paying",
      goals: 0,
      due: 3,
    });
    expect(settleAnswerOf({ status: "done" })).toBeUndefined();
    expect(isLive(goal)).toBe(true);
    expect(isLive({ status: "reached", finalAt: null })).toBe(true);
    expect(isLive({ status: "reached", finalAt: "x" })).toBe(false);
    expect(isLive({ status: "scheduled", finalAt: null })).toBe(false);
  });
});

describe("unlock steps on the dashboard (T-306c)", () => {
  const options = {
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
  const unlockGoal: Goal = {
    ...goal,
    id: "g2",
    steps: [
      {
        ...goal.steps[1],
        threshold: 200,
        isGoal: true,
        reward: {
          kind: "unlock",
          points: null,
          moment: null,
          unlock: { kind: "reward", id: "r1", name: { ar: null, en: "Hoodie" } },
        },
        reachedAt: null,
        due: 0,
        paid: 0,
        skipped: 0,
      },
    ],
  };

  it("reads an unlock into the form and back into the body", () => {
    const draft = goalDraftOf(unlockGoal, ZONE);
    expect(draft.reward).toMatchObject({ kind: "unlock", targetKind: "reward", targetId: "r1" });
    expect(goalBodyOf(draft, ZONE, unlockGoal)["reward"]).toEqual({
      kind: "unlock",
      target: { kind: "reward", id: "r1" },
    });
    expect(blankReward()).toMatchObject({ targetKind: "quest", targetId: "" });
  });

  it("offers no live poll and nothing the goal counts, and marks targets another goal unlocks", () => {
    const taken = takenTargets([goal, unlockGoal], null);
    expect([...taken]).toEqual(["reward:r1"]);
    expect(takenTargets([unlockGoal], "g2").size).toBe(0);
    const draft = {
      measure: "completions" as const,
      scope: "quest" as const,
      questId: "q1",
      categoryId: "",
    };
    expect(targetChoices("quest", options, draft, taken).map((choice) => choice.id)).toEqual([
      "q3",
    ]);
    expect(targetChoices("category", options, draft, taken).map((choice) => choice.id)).toEqual([
      "c2",
    ]);
    expect(targetChoices("reward", options, draft, taken)).toEqual([
      { id: "r1", name: "Hoodie", taken: true },
    ]);
    const byCategory = { ...draft, scope: "category" as const, categoryId: "c2" };
    expect(
      targetChoices("category", options, byCategory, taken).map((choice) => choice.id),
    ).toEqual(["c1"]);
    const points = { ...draft, measure: "points" as const };
    expect(targetChoices("quest", options, points, taken).map((choice) => choice.id)).toEqual([
      "q1",
      "q3",
    ]);
    expect(targetChoices("category", options, points, taken)).toHaveLength(2);
  });
});
