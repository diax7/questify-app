import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  markSeen,
  operatorQueue,
  removeSubmission,
  sendSubmission,
  staffQueue,
} from "#src/submissions/submissions";

// Each document its own version, so the send is seen to name the guidelines' version and no other.
vi.mock("@questify/shared", async (original) => ({
  ...(await original<object>()),
  playerDocuments: () => [
    { id: "terms_of_use", field: "terms", version: "terms-1" },
    { id: "community_guidelines", field: "guidelines", version: "guidelines-7" },
    { id: "privacy_policy", field: "privacy", version: "privacy-2" },
  ],
}));

const PLAYER = "22222222-2222-4222-8222-222222222222";
const EVENT = "33333333-3333-4333-8333-333333333333";
const STAFF = {
  staffUserId: "44444444-4444-4444-8444-444444444444",
  organizerId: "55555555-5555-4555-8555-555555555555",
};
const AT = new Date("2030-01-01T10:00:00Z");

type Answer = (sql: string, values: unknown[]) => Record<string, unknown>[] | Error;

/** A pool whose connection answers each call through `answer`, keeping each statement. */
function fakePool(answer: Answer) {
  const statements: { sql: string; values: unknown[] }[] = [];
  const client = {
    query: vi.fn(async (sql: string, values: unknown[] = []) => {
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql) || sql.includes("set_config")) {
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
  return { deps: { pool: { connect: async () => client } as unknown as Pool }, statements };
}

const pgError = (code: string | undefined, detail?: string) =>
  Object.assign(new Error("refused"), { code, ...(detail === undefined ? {} : { detail }) });

const PAGE = { eventId: EVENT, cursor: null, limit: 10 };

describe("refusals (migration 0040's SQLSTATEs)", () => {
  it.each([
    ["QC404", undefined, { kind: "not_found" }],
    ["SN404", undefined, { kind: "not_found" }],
    ["AN404", undefined, { kind: "not_found" }],
    ["AE404", undefined, { kind: "not_found" }],
    ["QC403", "banned", { kind: "enrollment_inactive", reason: "banned" }],
    ["QC403", undefined, { kind: "enrollment_inactive", reason: "" }],
    ["QN403", "ended", { kind: "quest_not_open", reason: "ended" }],
    ["QP403", undefined, { kind: "operator_not_playing" }],
    ["SQ422", undefined, { kind: "not_submission_quest" }],
    ["SV422", "too_long", { kind: "invalid_text", reason: "too_long" }],
    ["SG403", undefined, { kind: "guidelines_required" }],
    ["SP409", undefined, { kind: "pending" }],
    ["QD409", "closed", { kind: "closed" }],
    ["QD409", "1", { kind: "already_completed" }],
    ["QK422", undefined, { kind: "key_reused" }],
    ["SK422", undefined, { kind: "key_reused" }],
    ["AK422", undefined, { kind: "key_reused" }],
    ["SR409", "removed", { kind: "already_removed" }],
    ["SR409", "approved", { kind: "already_reviewed" }],
    ["SE409", undefined, { kind: "not_approvable" }],
    ["RF409", undefined, { kind: "results_final" }],
    ["AR400", undefined, { kind: "reason_required" }],
    ["SS403", undefined, { kind: "self_review" }],
    ["OP403", undefined, { kind: "not_operator" }],
    ["OA403", undefined, { kind: "ability_off" }],
    ["OS403", undefined, { kind: "outside_station" }],
    ["AD409", undefined, { kind: "already_removed" }],
    ["AO409", undefined, { kind: "open_reservation" }],
    ["AS409", undefined, { kind: "removal_closed" }],
  ] as const)("answers %s (%s) as its refusal", async (code, detail, expected) => {
    const { deps } = fakePool(() => pgError(code, detail));
    await expect(operatorQueue(deps, PLAYER, PAGE)).resolves.toEqual(expected);
  });

  it("throws any other error, with or without a code", async () => {
    const unknown = pgError("XX000");
    await expect(operatorQueue(fakePool(() => unknown).deps, PLAYER, PAGE)).rejects.toBe(unknown);
    const bare = pgError(undefined);
    await expect(operatorQueue(fakePool(() => bare).deps, PLAYER, PAGE)).rejects.toBe(bare);
  });
});

describe("sending", () => {
  const SENT = { submission_id: "5", points: 150, score: "0", balance: "0", replayed: false };
  const LEVEL = { level_up: 2, up_title_ar: "مستكشف", up_title_en: "Explorer" };

  it("names the guidelines' version, and reads no level for a pending send", async () => {
    const pool = fakePool(() => [{ ...SENT, status: "pending", completion_id: null }]);
    const sent = await sendSubmission(pool.deps, {
      playerId: PLAYER,
      questId: "q1",
      text: "Hello",
      idempotencyKey: "k1",
    });
    expect(sent).toEqual({
      kind: "done",
      value: {
        submissionId: "5",
        status: "pending",
        points: 150,
        completionId: null,
        score: 0,
        balance: 0,
        replayed: false,
        levelUp: null,
        bonus: null,
        item: null,
        boost: null,
      },
    });
    expect(pool.statements.map((statement) => statement.values)).toEqual([
      ["q1", "Hello", "guidelines-7", "k1"],
    ]);
  });

  it("reads the level and the category bonus an auto-approved send reached", async () => {
    const pool = fakePool((sql) => {
      if (sql.includes("own_level")) {
        return [LEVEL];
      }
      if (sql.includes("own_bonus")) {
        return [
          {
            category_id: "c1",
            points: "50",
            name_ar: null,
            name_en: "Stage",
            item_ar: "قبعة",
            item_en: null,
            item_outcome: "claim_closed",
            item_until: null,
            item_time_zone: "Asia/Riyadh",
          },
        ];
      }
      if (sql.includes("own_quest_item")) {
        return [
          {
            name_ar: null,
            name_en: "T-shirt",
            outcome: "pending",
            until: new Date("2030-01-01T18:00:00Z"),
            time_zone: "Asia/Riyadh",
          },
        ];
      }
      return [{ ...SENT, status: "approved", completion_id: "77", score: "150", replayed: true }];
    });
    const sent = await sendSubmission(pool.deps, {
      playerId: PLAYER,
      questId: "q1",
      text: "Hello",
      idempotencyKey: "k1",
    });
    expect(sent).toMatchObject({
      kind: "done",
      value: {
        completionId: "77",
        score: 150,
        replayed: true,
        levelUp: { level: 2, title: { ar: "مستكشف", en: "Explorer" } },
        bonus: {
          categoryId: "c1",
          points: 50,
          category: { ar: null, en: "Stage" },
          item: { name: { ar: "قبعة", en: null }, outcome: "claim_closed", until: null },
        },
        item: {
          name: { ar: null, en: "T-shirt" },
          outcome: "pending",
          until: { at: "2030-01-01T18:00:00.000Z", timeZone: "Asia/Riyadh" },
        },
      },
    });
    expect(pool.statements[1]?.values).toEqual(["77"]);
    expect(pool.statements[2]?.values).toEqual(["77"]);
    expect(pool.statements[3]?.values).toEqual(["77"]);
  });
});

describe("the queue, removal and seen marks", () => {
  it("reads a queue item, its quest title in both languages", async () => {
    const pool = fakePool(() => [
      {
        id: "9",
        quest_id: "q1",
        quest_title_ar: "أخبرنا",
        quest_title_en: "Tell us",
        enrollment_id: "e1",
        username: "sara",
        avatar: "fox",
        body: "Hello",
        points: 150,
        status: "pending",
        auto: false,
        marked: true,
        reason: null,
        reason_system: false,
        created_at: AT,
        reviewed_at: null,
        seen_at: null,
      },
    ]);
    const queue = await staffQueue(pool.deps, STAFF, { ...PAGE, filter: "pending" });
    expect(queue).toEqual({
      kind: "done",
      value: [
        {
          id: "9",
          questId: "q1",
          questTitle: { ar: "أخبرنا", en: "Tell us" },
          enrollmentId: "e1",
          username: "sara",
          avatar: "fox",
          text: "Hello",
          points: 150,
          status: "pending",
          auto: false,
          marked: true,
          reason: null,
          reasonSystem: false,
          createdAt: AT,
          reviewedAt: null,
          seenAt: null,
        },
      ],
    });
    expect(pool.statements[0]?.values).toEqual([EVENT, "pending", null, 10]);
  });

  it.each([
    [true, { entryId: "31", scoreDelta: -150, balanceDelta: -100, replayed: true, item: null }],
    [
      false,
      { entryId: "31", scoreDelta: -150, balanceDelta: -100, replayed: false, item: "cancelled" },
    ],
  ])("reads a removal (replayed %s)", async (replayed, expected) => {
    const pool = fakePool(() => [
      {
        entry_id: 31,
        score_delta: "-150",
        balance_delta: "-100",
        replayed,
        item: replayed ? null : "cancelled",
      },
    ]);
    const removed = await removeSubmission(pool.deps, STAFF, {
      eventId: EVENT,
      submissionId: "9",
      reason: "Copied",
      idempotencyKey: "k1",
      requestId: "r1",
    });
    expect(removed).toEqual({ kind: "done", value: expected });
  });

  it("answers how many were marked seen, and none when the database answers no row", async () => {
    const marked = fakePool(() => [{ marked: 3 }]);
    await expect(markSeen(marked.deps, STAFF, { eventId: EVENT, ids: ["1"] })).resolves.toEqual({
      kind: "done",
      value: 3,
    });
    await expect(
      markSeen(fakePool(() => []).deps, STAFF, { eventId: EVENT, ids: ["1"] }),
    ).resolves.toEqual({ kind: "done", value: 0 });
  });
});
