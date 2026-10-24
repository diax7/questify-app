import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  asTeam,
  communityPlatformOn,
  deleteGoal,
  goalBody,
  listGoals,
  refusalOf,
  saveGoal,
} from "#src/community/goals";

const valid = {
  title: { en: "Light the tower" },
  measure: "points",
  target: 100,
  startsAt: "2030-01-01T10:00:00.000Z",
  endsAt: "2030-01-01T10:01:00.000Z",
  reward: { kind: "points", points: 20 },
  milestones: [{ threshold: 99, reward: { kind: "nothing" } }],
};
const issuesOf = (body: object) => {
  const result = goalBody.safeParse(body);
  return result.success ? [] : result.error.issues.map((issue) => issue.path.join("."));
};

describe("goalBody", () => {
  it("takes a valid goal, with a one-minute window and up to 5 milestones below the target", () => {
    expect(issuesOf(valid)).toEqual([]);
    const five = [1, 2, 3, 4, 5].map((threshold) => ({ threshold, reward: { kind: "nothing" } }));
    expect(issuesOf({ ...valid, milestones: five })).toEqual([]);
    expect(
      issuesOf({ ...valid, milestones: [...five, { threshold: 6, reward: { kind: "nothing" } }] }),
    ).toEqual(["milestones"]);
  });

  it("names each broken cross-field rule", () => {
    expect(
      issuesOf({
        ...valid,
        measure: "completions",
        questId: crypto.randomUUID(),
        categoryId: crypto.randomUUID(),
      }),
    ).toEqual(["categoryId"]);
    expect(issuesOf({ ...valid, questId: crypto.randomUUID() })).toEqual(["measure"]);
    expect(issuesOf({ ...valid, categoryId: crypto.randomUUID() })).toEqual(["measure"]);
    expect(issuesOf({ ...valid, measure: "players", target: 1_000_001, milestones: [] })).toEqual([
      "target",
    ]);
    expect(issuesOf({ ...valid, measure: "players", target: 1_000_000, milestones: [] })).toEqual(
      [],
    );
    expect(issuesOf({ ...valid, target: 1_000_000_000, milestones: [] })).toEqual([]);
    expect(issuesOf({ ...valid, endsAt: "2030-01-01T10:00:59.999Z" })).toEqual(["endsAt"]);
    expect(
      issuesOf({ ...valid, milestones: [{ threshold: 100, reward: { kind: "nothing" } }] }),
    ).toEqual(["milestones"]);
    expect(
      issuesOf({
        ...valid,
        milestones: [
          { threshold: 5, reward: { kind: "nothing" } },
          { threshold: 5, reward: { kind: "nothing" } },
        ],
      }),
    ).toEqual(["milestones"]);
  });

  it("checks the texts and the rewards", () => {
    expect(issuesOf({ ...valid, title: {} })).toEqual(["title"]);
    expect(issuesOf({ ...valid, title: { en: "x".repeat(81) } })).toEqual(["title.en"]);
    expect(issuesOf({ ...valid, reward: { kind: "points", points: 0 } })).toEqual([
      "reward.points",
    ]);
    expect(
      issuesOf({ ...valid, reward: { kind: "moment", moment: { ar: "تُعزف الأغنية" } } }),
    ).toEqual([]);
    expect(
      issuesOf({ ...valid, reward: { kind: "moment", moment: { ar: "x".repeat(281) } } }),
    ).toEqual(["reward.moment.ar"]);
    expect(issuesOf({ ...valid, reward: { kind: "teleport" } })).toEqual(["reward.kind"]);
    expect(issuesOf({ ...valid, reward: { kind: "unlock" } })).toEqual(["reward.target"]);
  });

  it("takes an unlock of one quest, category or shop reward (T-306c)", () => {
    for (const kind of ["quest", "category", "reward"]) {
      expect(
        issuesOf({
          ...valid,
          reward: { kind: "unlock", target: { kind, id: crypto.randomUUID() } },
        }),
      ).toEqual([]);
    }
    expect(
      issuesOf({
        ...valid,
        reward: { kind: "unlock", target: { kind: "badge", id: crypto.randomUUID() } },
      }),
    ).toEqual(["reward.target.kind"]);
    expect(
      issuesOf({ ...valid, reward: { kind: "unlock", target: { kind: "quest", id: "nope" } } }),
    ).toEqual(["reward.target.id"]);
    expect(
      issuesOf({
        ...valid,
        reward: { kind: "unlock", target: { kind: "quest", id: crypto.randomUUID(), more: 1 } },
      }),
    ).toEqual(["reward.target"]);
    expect(issuesOf({ ...valid, extra: true })).toEqual([""]);
  });
});

describe("refusalOf", () => {
  it.each([
    [{ code: "AN404" }, { kind: "not_found" }],
    [{ code: "GN404" }, { kind: "not_found" }],
    [
      { code: "CG422", detail: "startsAt" },
      { kind: "invalid", issues: ["startsAt"] },
    ],
    [{ code: "CG422" }, { kind: "invalid", issues: ["goal"] }],
    [
      { code: "CG422", detail: "unlock", hint: "unlock_counted" },
      { kind: "invalid", issues: ["unlock_counted"] },
    ],
    [
      { code: "CG422", detail: "unlock" },
      { kind: "invalid", issues: ["unlock"] },
    ],
    [{ code: "GL409", detail: "unlock_taken" }, { kind: "unlock_taken" }],
    [{ code: "23505", constraint: "community_step_unlock_quest_key" }, { kind: "unlock_taken" }],
    [
      { code: "23503", constraint: "community_step_unlock_reward_fkey" },
      { kind: "invalid", issues: ["unlock_target"] },
    ],
    [{ code: "GL409", detail: "goal_overlap" }, { kind: "overlap" }],
    [
      { code: "GL409", detail: "goal_locked", hint: "target" },
      { kind: "locked", field: "target" },
    ],
    [
      { code: "GL409", detail: "goal_locked" },
      { kind: "locked", field: "goal" },
    ],
    [{ code: "GL409", detail: "goal_started" }, { kind: "started" }],
    [{ code: "GL409", detail: "event_ended" }, { kind: "event_ended" }],
    [
      { code: "GL409", detail: "goal_limit" },
      { kind: "limit_reached", limit: 20 },
    ],
    [{ code: "CO403" }, { kind: "owner_only" }],
    [{ code: "CS409" }, { kind: "settling" }],
    [
      { code: "23503", constraint: "community_goal_quest_id_event_id_fkey" },
      { kind: "invalid", issues: ["questId"] },
    ],
    [
      { code: "23503", constraint: "community_goal_category_id_event_id_fkey" },
      { kind: "invalid", issues: ["categoryId"] },
    ],
    [
      { code: "23505", constraint: "community_step_goal_id_threshold_key" },
      { kind: "invalid", issues: ["milestones"] },
    ],
    [{ code: "23514" }, { kind: "invalid", issues: ["milestones"] }],
    [{ code: "23505" }, { kind: "invalid", issues: ["milestones"] }],
  ] as const)("answers %o as %o", (error, expected) => {
    expect(refusalOf(error)).toEqual(expected);
  });

  it("leaves anything else to be thrown", () => {
    expect(refusalOf({ code: "GL409", detail: "other" })).toBeUndefined();
    expect(refusalOf({ code: "GL409" })).toBeUndefined();
    expect(refusalOf({ code: "XX000" })).toBeUndefined();
    expect(refusalOf({})).toBeUndefined();
  });
});

const settings = (answer: unknown) => ({ forEvent: vi.fn(async () => answer) }) as never;

describe("communityPlatformOn", () => {
  it("is on unless the platform switched it off, and off when the configuration cannot be read", async () => {
    expect(await communityPlatformOn(settings({ kind: "ok", config: { features: {} } }))).toBe(
      true,
    );
    expect(
      await communityPlatformOn(
        settings({ kind: "ok", config: { features: { community: { enabled: true } } } }),
      ),
    ).toBe(true);
    expect(
      await communityPlatformOn(
        settings({ kind: "ok", config: { features: { community: { enabled: false } } } }),
      ),
    ).toBe(false);
    expect(await communityPlatformOn(settings({ kind: "not_found" }))).toBe(false);
  });
});

type Answer = (sql: string) => Record<string, unknown>[];

/** A pool whose connection answers each statement through `answer`, keeping the statements and their values. */
function fakePool(answer: Answer) {
  const statements: { sql: string; values: unknown[] }[] = [];
  const client = {
    query: vi.fn(async (sql: string, values: unknown[] = []) => {
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql) || sql.includes("set_config")) {
        return { rows: [] };
      }
      statements.push({ sql, values });
      return { rows: answer(sql) };
    }),
    release: vi.fn(),
  };
  return { pool: { connect: async () => client } as unknown as Pool, statements };
}

const CONTEXT = {
  organizerId: "11111111-1111-4111-8111-111111111111",
  staffUserId: "22222222-2222-4222-8222-222222222222",
};
const EVENT = "33333333-3333-4333-8333-333333333333";
const on = settings({ kind: "ok", config: { features: {} } });
const off = settings({ kind: "ok", config: { features: { community: { enabled: false } } } });

/** A goal as `community_goals` writes it (jsonb, times with their offset). */
const stored = (over: Record<string, unknown> = {}) => ({
  id: "goal-1",
  title: { ar: "أضيئوا البرج", en: "Light the tower" },
  measure: "completions",
  questId: null,
  categoryId: "cat-1",
  target: "100",
  startsAt: "2030-01-01T13:00:00+03:00",
  endsAt: "2030-01-01T14:00:00+03:00",
  closesAt: "2030-01-01T13:30:00+03:00",
  paidTo: "everyone",
  status: "running",
  progress: "40",
  progressAt: "2030-01-01T13:10:00+03:00",
  finalAt: null,
  started: true,
  steps: [
    {
      threshold: "50",
      isGoal: false,
      reward: "unlock",
      points: null,
      moment: null,
      unlock: { kind: "quest", id: "quest-1", name: { en: "Find the key" } },
      reachedAt: "2030-01-01T13:05:00+03:00",
      due: "3",
      paid: "2",
      skipped: "1",
    },
    {
      threshold: "100",
      isGoal: true,
      reward: "points",
      points: "20",
      moment: null,
      unlock: null,
      reachedAt: null,
      due: "0",
      paid: "0",
      skipped: "0",
    },
  ],
  ...over,
});

describe("listGoals", () => {
  it("answers each goal as the dashboard reads it, times in UTC and counts as numbers", async () => {
    const { pool } = fakePool(() => [{ goals: [stored()] }]);
    expect(await listGoals({ pool, settings: on }, CONTEXT, EVENT)).toEqual({
      kind: "done",
      value: [
        {
          id: "goal-1",
          title: { ar: "أضيئوا البرج", en: "Light the tower" },
          measure: "completions",
          questId: null,
          categoryId: "cat-1",
          target: 100,
          startsAt: "2030-01-01T10:00:00.000Z",
          endsAt: "2030-01-01T11:00:00.000Z",
          closesAt: "2030-01-01T10:30:00.000Z",
          paidTo: "everyone",
          status: "running",
          progress: 40,
          progressAt: "2030-01-01T10:10:00.000Z",
          finalAt: null,
          started: true,
          steps: [
            {
              threshold: 50,
              isGoal: false,
              reward: {
                kind: "unlock",
                points: null,
                moment: null,
                unlock: { kind: "quest", id: "quest-1", name: { ar: null, en: "Find the key" } },
              },
              reachedAt: "2030-01-01T10:05:00.000Z",
              due: 3,
              paid: 2,
              skipped: 1,
            },
            {
              threshold: 100,
              isGoal: true,
              reward: { kind: "points", points: 20, moment: null, unlock: null },
              reachedAt: null,
              due: 0,
              paid: 0,
              skipped: 0,
            },
          ],
        },
      ],
    });
  });

  it("reads a goal for a quest, not started, with no steps", async () => {
    const { pool } = fakePool(() => [
      {
        goals: [
          stored({
            questId: "quest-1",
            categoryId: null,
            started: false,
            progressAt: null,
            finalAt: "2030-01-01T14:00:00+03:00",
            steps: null,
          }),
        ],
      },
    ]);
    expect(await listGoals({ pool, settings: on }, CONTEXT, EVENT)).toMatchObject({
      kind: "done",
      value: [
        {
          questId: "quest-1",
          categoryId: null,
          started: false,
          progressAt: null,
          finalAt: "2030-01-01T11:00:00.000Z",
          steps: [],
        },
      ],
    });
  });

  it("answers no goals when the event has none", async () => {
    const { pool } = fakePool(() => [{ goals: null }]);
    expect(await listGoals({ pool, settings: on }, CONTEXT, EVENT)).toEqual({
      kind: "done",
      value: [],
    });
  });
});

/** A save that answers `id`, then the event's `goals`. */
const savedAs = (id: string, goals: object[]) =>
  fakePool((sql) => (sql.includes("save_community_goal") ? [{ id }] : [{ goals }]));
/** The goal as the first statement wrote it. */
const written = (statements: { values: unknown[] }[]) =>
  JSON.parse(String(statements[0]?.values[2])) as Record<string, unknown>;

describe("saveGoal and deleteGoal", () => {
  const body = goalBody.parse({ ...valid, measure: "completions", milestones: undefined });
  const request = (over: object = {}) => ({
    eventId: EVENT,
    goalId: null,
    body,
    requestId: "req-1",
    ...over,
  });

  it("answers the saved goal among the event's, writing absent fields as the database reads them", async () => {
    const { pool, statements } = savedAs("goal-2", [
      stored(),
      stored({ id: "goal-2", title: { en: "Second" } }),
    ]);
    expect(await saveGoal({ pool, settings: on }, CONTEXT, request())).toMatchObject({
      kind: "done",
      value: { id: "goal-2", title: { ar: null, en: "Second" } },
    });
    expect(written(statements)).toMatchObject({
      questId: null,
      categoryId: null,
      paidTo: "contributors",
      milestones: [],
    });
  });

  it("writes the category the goal counts", async () => {
    const category = "44444444-4444-4444-8444-444444444444";
    const { pool, statements } = savedAs("goal-1", [stored()]);
    await saveGoal(
      { pool, settings: on },
      CONTEXT,
      request({ body: { ...body, categoryId: category } }),
    );
    expect(written(statements)).toMatchObject({ categoryId: category });
  });

  it("answers not found when the saved goal is not among the event's", async () => {
    const { pool } = savedAs("goal-9", [stored()]);
    expect(await saveGoal({ pool, settings: on }, CONTEXT, request())).toEqual({
      kind: "not_found",
    });
  });

  it("is refused, writing nothing, while the platform switch is off", async () => {
    const saving = fakePool(() => []);
    expect(await saveGoal({ pool: saving.pool, settings: off }, CONTEXT, request())).toEqual({
      kind: "feature_off",
    });
    expect(saving.statements).toEqual([]);
    const deleting = fakePool(() => []);
    expect(
      await deleteGoal({ pool: deleting.pool, settings: off }, CONTEXT, {
        eventId: EVENT,
        goalId: "goal-1",
        requestId: "req-1",
      }),
    ).toEqual({ kind: "feature_off" });
    expect(deleting.statements).toEqual([]);
  });
});

describe("asTeam", () => {
  it("throws a failure that is no refusal as it came", async () => {
    const failure = new Error("connection lost");
    const { pool } = fakePool(() => []);
    await expect(
      asTeam({ pool }, CONTEXT, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
  });
});
