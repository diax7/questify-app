import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import type { AuthKeys } from "#src/auth/keys";
import { AWARD_FIND_LIMIT } from "#src/auth/limits";
import {
  awardForm,
  bulkAward,
  findPlayer,
  memberLedger,
  operatorAward,
  previewList,
  previewQuest,
  removeAward,
  report,
  setCaps,
  staffAward,
} from "#src/awards/awards";

const OPERATOR = "22222222-2222-4222-8222-222222222222";
const EVENT = "33333333-3333-4333-8333-333333333333";
const STAFF = {
  staffUserId: "44444444-4444-4444-8444-444444444444",
  organizerId: "55555555-5555-4555-8555-555555555555",
};
const AT = new Date("2030-01-01T10:00:00Z");

type Answer = (sql: string, values: unknown[]) => Record<string, unknown>[] | Error;

/** A pool whose connection answers each call through `answer`, keeping each statement and the context it ran in. */
function fakePool(answer: Answer) {
  const statements: { sql: string; values: unknown[] }[] = [];
  const contexts: unknown[][] = [];
  const client = {
    query: vi.fn(async (sql: string, values: unknown[] = []) => {
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) {
        return { rows: [] };
      }
      if (sql.includes("set_config")) {
        contexts.push(values);
        return { rows: [] };
      }
      statements.push({ sql, values });
      const rows = answer(sql, values);
      if (rows instanceof Error) {
        throw rows;
      }
      return { rows };
    }),
    release: vi.fn(),
  };
  const keys = { playerKey: (id: string) => Buffer.from(`key:${id}`) } as unknown as AuthKeys;
  return {
    deps: { pool: { connect: async () => client } as unknown as Pool, keys },
    statements,
    contexts,
  };
}

const pgError = (code: string | undefined, detail?: string, hint?: string) =>
  Object.assign(new Error("refused"), {
    code,
    ...(detail === undefined ? {} : { detail }),
    ...(hint === undefined ? {} : { hint }),
  });

const AWARD = {
  eventId: EVENT,
  enrollmentId: "e1",
  what: { questId: null, points: 50 },
  reason: "Helped",
  idempotencyKey: "k1",
} as const;

describe("refusals (migration 0030's SQLSTATEs)", () => {
  it.each([
    ["OP403", undefined, undefined, { kind: "not_operator" }],
    ["OA403", undefined, undefined, { kind: "ability_off" }],
    ["OS403", undefined, undefined, { kind: "outside_station" }],
    ["AY409", undefined, undefined, { kind: "self_award" }],
    ["QC404", undefined, undefined, { kind: "not_found" }],
    ["AQ404", undefined, undefined, { kind: "not_found" }],
    ["AN404", undefined, undefined, { kind: "not_found" }],
    ["AE404", undefined, undefined, { kind: "not_found" }],
    ["QC403", "banned", undefined, { kind: "enrollment_inactive", reason: "banned" }],
    ["QC403", undefined, undefined, { kind: "enrollment_inactive", reason: "" }],
    ["QN403", "event_not_live", undefined, { kind: "quest_not_open", reason: "event_not_live" }],
    ["QD409", undefined, undefined, { kind: "already_completed" }],
    ["QP403", undefined, undefined, { kind: "operator_not_playing" }],
    ["AC409", "each", "200,450", { kind: "over_cap", cap: "each", limit: 200, left: 450 }],
    ["AC409", "day", "500,50", { kind: "over_cap", cap: "day", limit: 500, left: 50 }],
    ["AC409", "other", "7", { kind: "over_cap", cap: "each", limit: 7, left: 0 }],
    ["AC409", undefined, undefined, { kind: "over_cap", cap: "each", limit: 0, left: 0 }],
    ["AR400", undefined, undefined, { kind: "reason_required" }],
    ["AP400", undefined, undefined, { kind: "invalid_amount" }],
    ["AK422", undefined, undefined, { kind: "key_reused" }],
    ["QK422", undefined, undefined, { kind: "key_reused" }],
    ["AD409", undefined, undefined, { kind: "already_removed" }],
    ["AO409", undefined, undefined, { kind: "open_reservation" }],
    ["AT422", undefined, undefined, { kind: "not_removable" }],
    ["AS409", undefined, undefined, { kind: "removal_closed" }],
    ["RF409", "results_final", undefined, { kind: "results_final" }],
    ["AB400", undefined, undefined, { kind: "too_many_lines" }],
  ] as const)("answers %s (%s, %s) as its refusal", async (code, detail, hint, expected) => {
    const { deps } = fakePool(() => pgError(code, detail, hint));
    await expect(operatorAward(deps, OPERATOR, AWARD)).resolves.toEqual(expected);
  });

  it("throws any other error, with or without a code", async () => {
    const unknown = pgError("XX000");
    await expect(operatorAward(fakePool(() => unknown).deps, OPERATOR, AWARD)).rejects.toBe(
      unknown,
    );
    const bare = pgError(undefined);
    await expect(operatorAward(fakePool(() => bare).deps, OPERATOR, AWARD)).rejects.toBe(bare);
  });
});

describe("awards", () => {
  it("sends the operator's award in their own context and reads the answer", async () => {
    const pool = fakePool(() => [{ entry_id: 9, points: 50, replayed: true }]);
    await expect(operatorAward(pool.deps, OPERATOR, AWARD)).resolves.toEqual({
      kind: "done",
      value: { entryId: "9", points: 50, replayed: true },
    });
    expect(pool.statements[0]?.values).toEqual([EVENT, "e1", null, 50, "Helped", "k1"]);
    expect(pool.contexts[0]?.[1]).toEqual(["", OPERATOR, "", ""]);
  });

  it("reads a first award as not replayed, and sends a quest award from staff", async () => {
    const pool = fakePool(() => [{ entry_id: 3, points: 150, replayed: false }]);
    const done = await staffAward(pool.deps, STAFF, {
      ...AWARD,
      what: { questId: "q1", points: null },
      requestId: "r1",
    });
    expect(done).toEqual({ kind: "done", value: { entryId: "3", points: 150, replayed: false } });
    expect(pool.statements[0]?.values).toEqual([EVENT, "e1", "q1", null, "Helped", "k1", "r1"]);
    expect(pool.contexts[0]?.[1]).toEqual([STAFF.organizerId, "", STAFF.staffUserId, ""]);
  });

  it("reads a removal", async () => {
    const pool = fakePool(() => [
      { entry_id: 12, score_delta: -200, balance_delta: -50, replayed: true, item: "cancelled" },
    ]);
    const done = await removeAward(pool.deps, STAFF, {
      eventId: EVENT,
      entryId: "7",
      reason: "Cheat",
      idempotencyKey: "k",
      requestId: "r",
    });
    expect(done).toEqual({
      kind: "done",
      value: {
        entryId: "12",
        scoreDelta: -200,
        balanceDelta: -50,
        replayed: true,
        item: "cancelled",
      },
    });
    expect(pool.statements[0]?.values).toEqual([EVENT, "7", "Cheat", "k", "r"]);
    const fresh = fakePool(() => [
      { entry_id: 1, score_delta: 0, balance_delta: 0, replayed: false },
    ]);
    const first = await removeAward(fresh.deps, STAFF, {
      eventId: EVENT,
      entryId: "7",
      reason: "Cheat",
      idempotencyKey: "k",
      requestId: "r",
    });
    expect(first).toMatchObject({ value: { replayed: false, item: null } });
    const kept = fakePool(() => [
      { entry_id: 2, score_delta: -5, balance_delta: -5, replayed: false, item: "handed_over" },
    ]);
    const handed = await removeAward(kept.deps, STAFF, {
      eventId: EVENT,
      entryId: "8",
      reason: "Cheat",
      idempotencyKey: "k2",
      requestId: "r",
    });
    expect(handed).toMatchObject({ value: { item: "handed_over" } });
    const odd = fakePool(() => [
      { entry_id: 3, score_delta: -5, balance_delta: -5, replayed: false, item: "lost" },
    ]);
    const unknown = await removeAward(odd.deps, STAFF, {
      eventId: EVENT,
      entryId: "9",
      reason: "Cheat",
      idempotencyKey: "k3",
      requestId: "r",
    });
    expect(unknown).toMatchObject({ value: { item: null } });
  });
});

describe("findPlayer", () => {
  const request = { eventId: EVENT, username: "sara", phone: null };

  it("counts the find, then answers the member", async () => {
    const pool = fakePool((sql) =>
      sql.includes("count(*)")
        ? [{ count: AWARD_FIND_LIMIT.max - 1, retry_after: 30 }]
        : sql.includes("INSERT")
          ? [{ at: "t" }]
          : [{ enrollment_id: "e1", username: "Sara_88", avatar: "fox", active: true }],
    );
    await expect(findPlayer(pool.deps, OPERATOR, request)).resolves.toEqual({
      kind: "done",
      value: { enrollmentId: "e1", username: "Sara_88", avatar: "fox", active: true },
    });
    expect(pool.statements.some((s) => s.sql.includes("INSERT"))).toBe(true);
    expect(pool.statements.at(-1)?.values).toEqual([EVENT, "sara", null]);
    expect(pool.contexts.at(-1)?.[1]).toEqual(["", OPERATOR, "", ""]);
  });

  it("answers no match, and an inactive member as not active", async () => {
    const none = fakePool((sql) => (sql.includes("count(*)") ? [{ count: 0 }] : []));
    await expect(findPlayer(none.deps, OPERATOR, request)).resolves.toEqual({
      kind: "done",
      value: null,
    });
    const banned = fakePool((sql) =>
      sql.includes("count(*)")
        ? [{ count: 0 }]
        : [{ enrollment_id: "e2", username: "x", avatar: "owl", active: false }],
    );
    await expect(findPlayer(banned.deps, OPERATOR, request)).resolves.toMatchObject({
      value: { active: false },
    });
  });

  it("refuses at the limit without recording or finding", async () => {
    const pool = fakePool(() => [{ count: AWARD_FIND_LIMIT.max, retry_after: 42 }]);
    await expect(findPlayer(pool.deps, OPERATOR, request)).resolves.toEqual({
      kind: "throttled",
      retryAfterSeconds: 42,
    });
    expect(pool.statements).toHaveLength(1);
  });
});

describe("awardForm", () => {
  it("reads the caps, what is left and the quests' titles", async () => {
    const pool = fakePool((sql) =>
      sql.includes("operator_award_state")
        ? [{ cap_each: 200, cap_day: 500, left_today: 450, live: true }]
        : [{ quest_id: "q1", title_ar: "كنز", title_en: null, points: 150 }],
    );
    await expect(awardForm(pool.deps, OPERATOR, EVENT)).resolves.toEqual({
      kind: "done",
      value: {
        capEach: 200,
        capDay: 500,
        leftToday: 450,
        live: true,
        quests: [{ id: "q1", title: { ar: "كنز", en: null }, points: 150 }],
      },
    });
  });

  it("reads anything but true as not live, and an English-only title", async () => {
    const pool = fakePool((sql) =>
      sql.includes("operator_award_state")
        ? [{ cap_each: 1, cap_day: 1, left_today: 0, live: "t" }]
        : [{ quest_id: "q", title_ar: null, title_en: "Hunt", points: 1 }],
    );
    await expect(awardForm(pool.deps, OPERATOR, EVENT)).resolves.toMatchObject({
      value: { live: false, quests: [{ title: { ar: null, en: "Hunt" } }] },
    });
  });
});

describe("memberLedger and report", () => {
  const base = {
    id: 5,
    at: AT,
    kind: "award",
    score_delta: 50,
    balance_delta: 50,
    quest_id: null,
    title_ar: null,
    title_en: null,
    reason: null,
    by_operator: null,
    by_staff: "Huda",
    reverses: null,
  };

  it("reads one member's record", async () => {
    const pool = fakePool(() => [
      { ...base, removable: true, removed: false },
      {
        ...base,
        id: 6,
        kind: "removal",
        quest_id: "q1",
        title_en: "Hunt",
        reason: "Cheat",
        by_operator: "op_1",
        by_staff: null,
        reverses: 4,
        removable: false,
        removed: true,
        multiplier: 2,
      },
    ]);
    const done = await memberLedger(pool.deps, STAFF, {
      eventId: EVENT,
      enrollmentId: "e1",
      beforeId: "9",
      limit: 25,
    });
    expect(done).toEqual({
      kind: "done",
      value: [
        {
          id: "5",
          at: AT,
          kind: "award",
          scoreDelta: 50,
          balanceDelta: 50,
          questId: null,
          title: { ar: null, en: null },
          reason: null,
          by: { operator: null, staff: "Huda" },
          reverses: null,
          removable: true,
          removed: false,
          multiplier: null,
        },
        {
          id: "6",
          at: AT,
          kind: "removal",
          scoreDelta: 50,
          balanceDelta: 50,
          questId: "q1",
          title: { ar: null, en: "Hunt" },
          reason: "Cheat",
          by: { operator: "op_1", staff: null },
          reverses: "4",
          removable: false,
          removed: true,
          multiplier: 2,
        },
      ],
    });
    expect(pool.statements[0]?.values).toEqual([EVENT, "e1", "9", 25]);
  });

  it("reads the report and the caps", async () => {
    const pool = fakePool((sql) =>
      sql.includes("award_cap_each")
        ? [{ award_cap_each: 200, award_cap_day: 500 }]
        : [
            {
              ...base,
              points: 50,
              enrollment_id: "e1",
              username: "sara",
              bulk_id: "b1",
              removed: true,
            },
            {
              ...base,
              id: 7,
              kind: "removal",
              points: 150,
              score_delta: -150,
              balance_delta: -20,
              reverses: 3,
              enrollment_id: "e2",
              username: "omar",
              quest_id: "q1",
              title_ar: "كنز",
              reason: "Cheat",
              bulk_id: null,
              by_operator: "op",
              by_staff: null,
              removed: false,
            },
          ],
    );
    const done = await report(pool.deps, STAFF, { eventId: EVENT, beforeId: null, limit: 2 });
    expect(done).toEqual({
      kind: "done",
      value: {
        caps: { each: 200, day: 500 },
        lines: [
          {
            id: "5",
            at: AT,
            kind: "award",
            points: 50,
            scoreDelta: 50,
            balanceDelta: 50,
            reverses: null,
            player: { enrollmentId: "e1", username: "sara" },
            quest: null,
            reason: null,
            bulkId: "b1",
            by: { operator: null, staff: "Huda" },
            removed: true,
          },
          {
            id: "7",
            at: AT,
            kind: "removal",
            points: 150,
            scoreDelta: -150,
            balanceDelta: -20,
            reverses: "3",
            player: { enrollmentId: "e2", username: "omar" },
            quest: { id: "q1", title: { ar: "كنز", en: null } },
            reason: "Cheat",
            bulkId: null,
            by: { operator: "op", staff: null },
            removed: false,
          },
        ],
      },
    });
    expect(pool.statements[0]?.values).toEqual([EVENT, null, 2]);
  });

  it("reads missing caps as not numbers rather than failing", async () => {
    const pool = fakePool(() => []);
    const done = await report(pool.deps, STAFF, { eventId: EVENT, beforeId: null, limit: 2 });
    expect(done).toEqual({ kind: "done", value: { caps: { each: NaN, day: NaN }, lines: [] } });
  });
});

describe("bulk awards and caps", () => {
  it("splits a list's matches into members, inactive lines and misses", async () => {
    const pool = fakePool(() => [
      { line: "sara", enrollment_id: "e1", username: "Sara", active: true },
      { line: "@SARA", enrollment_id: "e1", username: "Sara", active: true },
      { line: "omar", enrollment_id: "e2", username: "omar", active: false },
      { line: "nobody", enrollment_id: null, username: null, active: null },
    ]);
    const done = await previewList(pool.deps, STAFF, {
      eventId: EVENT,
      lines: { usernames: ["sara"], phones: ["+966500000000"] },
    });
    expect(done).toEqual({
      kind: "done",
      value: {
        matched: [{ enrollmentId: "e1", username: "Sara" }],
        inactive: ["omar"],
        notFound: ["nobody"],
      },
    });
    expect(pool.statements[0]?.values).toEqual([EVENT, ["sara"], ["+966500000000"]]);
  });

  it("counts a quest's completers", async () => {
    const pool = fakePool(() => [{ count: "4" }]);
    await expect(
      previewQuest(pool.deps, STAFF, { eventId: EVENT, questId: "q1" }),
    ).resolves.toEqual({
      kind: "done",
      value: 4,
    });
    expect(pool.statements[0]?.values).toEqual([EVENT, "q1"]);
    await expect(
      previewQuest(fakePool(() => []).deps, STAFF, { eventId: EVENT, questId: "q1" }),
    ).resolves.toEqual({ kind: "done", value: NaN });
  });

  it("sends a bulk award and reads its counts", async () => {
    const pool = fakePool(() => [{ bulk_id: "b1", awarded: 3, skipped: 1, replayed: true }]);
    const done = await bulkAward(pool.deps, STAFF, {
      eventId: EVENT,
      target: { enrollmentIds: ["e1"], questId: null },
      points: 25,
      reason: "Team",
      idempotencyKey: "k",
      requestId: "r",
    });
    expect(done).toEqual({
      kind: "done",
      value: { bulkId: "b1", awarded: 3, skipped: 1, replayed: true },
    });
    expect(pool.statements[0]?.values).toEqual([EVENT, ["e1"], null, 25, "Team", "k", "r"]);
    const first = fakePool(() => [{ bulk_id: "b2", awarded: 0, skipped: 0, replayed: false }]);
    await expect(
      bulkAward(first.deps, STAFF, {
        eventId: EVENT,
        target: { enrollmentIds: null, questId: "q1" },
        points: 25,
        reason: "Team",
        idempotencyKey: "k",
        requestId: "r",
      }),
    ).resolves.toMatchObject({ value: { replayed: false } });
  });

  it("sets the caps and reads the outcome, a missing one as not the owner", async () => {
    const pool = fakePool(() => [{ outcome: "changed" }]);
    await expect(
      setCaps(pool.deps, STAFF, { eventId: EVENT, each: 100, day: 400, requestId: "r" }),
    ).resolves.toEqual({ kind: "done", value: "changed" });
    expect(pool.statements[0]?.values).toEqual([EVENT, 100, 400, "r"]);
    await expect(
      setCaps(fakePool(() => []).deps, STAFF, { eventId: EVENT, each: 1, day: 1, requestId: "r" }),
    ).resolves.toEqual({ kind: "done", value: "not_owner" });
  });
});
