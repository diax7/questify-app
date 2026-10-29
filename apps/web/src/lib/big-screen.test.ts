import { describe, expect, it } from "vitest";
import {
  EMPTY_RECHECK_MS,
  isEmpty,
  moveRow,
  nextScene,
  percentOf,
  planOf,
  rowsFor,
  sceneAnswerOf,
  scenesOf,
  scenesToSave,
  shareOf,
  toggleRow,
  type BigScreenPlan,
  type Known,
  type Scene,
  type SceneAnswer,
} from "#src/lib/big-screen.ts";

const empty = (at: number): Known => ({ empty: true, at });
const full = (at: number): Known => ({ empty: false, at });
const answerOf = (scene: Scene, body: object): SceneAnswer => {
  const answer = sceneAnswerOf(scene, body);
  if (answer === undefined) {
    throw new Error("not an answer");
  }
  return answer;
};
const planFrom = (body: object): BigScreenPlan => {
  const plan = planOf(body);
  if (plan === undefined) {
    throw new Error("not a plan");
  }
  return plan;
};

describe("reading a scene", () => {
  it("reads the ranking's rows and ignores anything else in them", () => {
    expect(
      sceneAnswerOf("ranking", {
        shut: null,
        rows: [{ place: 1, username: "sara_k", avatar: "fox", score: 120, email: "x@y.z" }, "junk"],
      }),
    ).toEqual({
      scene: "ranking",
      shut: null,
      rows: [{ place: 1, username: "sara_k", avatar: "fox", score: 120 }],
    });
    expect(sceneAnswerOf("ranking", { shut: "ranking_off" })).toEqual({
      scene: "ranking",
      shut: "ranking_off",
      rows: [],
    });
    expect(sceneAnswerOf("ranking", "no")).toBeUndefined();
  });

  it("reads a community goal, with unknown measures and statuses falling back", () => {
    expect(
      sceneAnswerOf("community", {
        shut: null,
        goal: {
          title: { en: "Light the tower" },
          measure: "players",
          target: 100,
          progress: 40,
          status: "reached",
          steps: [
            { threshold: 25, isGoal: false, reached: true },
            { threshold: 100, isGoal: true },
          ],
        },
      }),
    ).toEqual({
      scene: "community",
      shut: null,
      goal: {
        title: { ar: null, en: "Light the tower" },
        measure: "players",
        target: 100,
        progress: 40,
        status: "reached",
        steps: [
          { threshold: 25, isGoal: false, reached: true },
          { threshold: 100, isGoal: true, reached: false },
        ],
      },
    });
    expect(
      sceneAnswerOf("community", { goal: { target: 5, measure: "x", status: "y" } }),
    ).toMatchObject({ goal: { measure: "points", status: "running", progress: 0, steps: [] } });
    expect(sceneAnswerOf("community", { goal: { target: 0 } })).toMatchObject({ goal: null });
  });

  it("reads a poll whose results are shown, and one whose results are held back", () => {
    expect(
      sceneAnswerOf("poll", {
        poll: {
          title: { en: "Pick one" },
          closed: true,
          voters: 3,
          options: [{ text: { en: "Robots" }, votes: 2 }],
        },
      }),
    ).toMatchObject({
      poll: { closed: true, voters: 3, options: [{ text: { ar: null, en: "Robots" }, votes: 2 }] },
    });
    expect(
      sceneAnswerOf("poll", { poll: { title: { en: "Pick" }, voters: 1, options: null } }),
    ).toMatchObject({ poll: { closed: false, options: null } });
    expect(sceneAnswerOf("poll", { shut: null, poll: null })).toMatchObject({ poll: null });
  });

  it("keeps only the scenes this page can run", () => {
    expect(scenesOf(["poll", "photos", 3, "ranking"])).toEqual(["poll", "ranking"]);
    expect(scenesOf("poll")).toEqual([]);
  });
});

describe("what is empty", () => {
  it("passes by a shut scene, no goal and no poll, but never an open ranking", () => {
    expect(isEmpty(answerOf("ranking", { rows: [] }))).toBe(false);
    expect(isEmpty(answerOf("ranking", { shut: "feature_off" }))).toBe(true);
    expect(isEmpty(answerOf("community", { goal: null }))).toBe(true);
    expect(isEmpty(answerOf("community", { goal: { target: 5 } }))).toBe(false);
    expect(isEmpty(answerOf("poll", { poll: null }))).toBe(true);
    expect(isEmpty(answerOf("poll", { poll: { voters: 0 } }))).toBe(false);
  });
});

describe("the next scene", () => {
  const scenes: readonly Scene[] = ["ranking", "community", "poll"];
  it("follows the picked order and wraps", () => {
    expect(nextScene(scenes, "ranking", {}, 0)).toBe("community");
    expect(nextScene(scenes, "poll", {}, 0)).toBe("ranking");
  });

  it("passes by a scene found empty a moment ago, and looks again after 20 seconds", () => {
    const known = { community: empty(1000), poll: full(1000) };
    expect(nextScene(scenes, "ranking", known, 5000)).toBe("poll");
    expect(nextScene(scenes, "ranking", known, 1000 + EMPTY_RECHECK_MS - 1)).toBe("poll");
    expect(nextScene(scenes, "ranking", known, 1000 + EMPTY_RECHECK_MS)).toBe("community");
  });

  it("stays when every other scene is empty, and with one scene", () => {
    const known = { community: empty(1000), poll: empty(1000) };
    expect(nextScene(scenes, "ranking", known, 2000)).toBe("ranking");
    expect(nextScene(["poll"], "poll", {}, 0)).toBe("poll");
  });
});

describe("bars", () => {
  it("rounds down to whole percent and stays between 0 and 100", () => {
    expect(percentOf(1, 3)).toBe(33);
    expect(percentOf(5, 3)).toBe(100);
    expect(percentOf(-2, 3)).toBe(0);
    expect(percentOf(4, 0)).toBe(0);
  });

  it("gives a poll option its share of all the votes cast", () => {
    const options = [
      { text: { ar: null, en: "a" }, votes: 3 },
      { text: { ar: null, en: "b" }, votes: 1 },
    ];
    expect(shareOf(3, options)).toBe(75);
    expect(
      shareOf(2, [
        { ...options[0]!, votes: 2 },
        { ...options[1]!, votes: 1 },
      ]),
    ).toBe(67);
    expect(shareOf(0, [{ text: { ar: null, en: "a" }, votes: 0 }])).toBe(0);
  });
});

describe("the Big screen page's list", () => {
  const plan = planFrom({
    scenes: ["poll", "ranking"],
    offered: ["ranking", "community", "poll"],
    enabled: true,
  });

  it("reads the plan, and refuses an answer that is not one", () => {
    expect(plan).toEqual({
      scenes: ["poll", "ranking"],
      offered: ["ranking", "community", "poll"],
      enabled: true,
    });
    expect(planOf({ scenes: ["poll"] })).toBeUndefined();
    expect(planOf({ scenes: [], offered: [], enabled: "yes" })).toMatchObject({ enabled: false });
  });

  it("lists the picked scenes first in their order, then the others", () => {
    expect(rowsFor(plan)).toEqual([
      { scene: "poll", on: true },
      { scene: "ranking", on: true },
      { scene: "community", on: false },
    ]);
  });

  it("leaves out a picked scene that is no longer offered", () => {
    const off = planFrom({
      scenes: ["ranking", "poll"],
      offered: ["community", "poll"],
      enabled: true,
    });
    expect(rowsFor(off).map((row) => row.scene)).toEqual(["poll", "community"]);
  });

  it("moves a line by one place and stops at the ends", () => {
    const rows = rowsFor(plan);
    expect(moveRow(rows, 0, 1).map((row) => row.scene)).toEqual(["ranking", "poll", "community"]);
    expect(moveRow(rows, 2, -1).map((row) => row.scene)).toEqual(["poll", "community", "ranking"]);
    expect(moveRow(rows, 0, -1)).toBe(rows);
    expect(moveRow(rows, 2, 1)).toBe(rows);
  });

  it("saves the ticked lines in order", () => {
    const rows = toggleRow(toggleRow(rowsFor(plan), "community"), "poll");
    expect(scenesToSave(rows)).toEqual(["ranking", "community"]);
    expect(scenesToSave(toggleRow(toggleRow(rows, "ranking"), "community"))).toEqual([]);
  });
});
