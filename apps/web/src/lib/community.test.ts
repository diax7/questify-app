import { describe, expect, it } from "vitest";
import {
  blankGoal,
  goalBodyOf,
  goalDraftOf,
  goalsOf,
  isLive,
  issuesOf,
  previewFills,
  settleAnswerOf,
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
      reward: { kind: "moment", points: null, moment: { ar: null, en: "Drums" } },
      reachedAt: "2030-01-01T07:30:00.000Z",
      due: 0,
      paid: 0,
      skipped: 0,
    },
    {
      threshold: 200,
      isGoal: true,
      reward: { kind: "points", points: 20, moment: null },
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
        reward: { kind: "nothing", points: "", momentAr: "", momentEn: "" },
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
