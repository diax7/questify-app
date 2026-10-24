import { describe, expect, it, vi } from "vitest";
import { communityPlatformOn, goalBody, refusalOf } from "#src/community/goals";

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
