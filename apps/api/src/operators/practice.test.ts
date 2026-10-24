import { describe, expect, it } from "vitest";
import type { Caller } from "#src/auth/sign-in";
import { practiceScan } from "#src/operators/practice";
import { createMyCodeKey, myCode } from "#src/quests/qr";
import { fakePool, type FakeAnswer } from "#test/support/fake-pool";

const KEY = createMyCodeKey("p".repeat(40));
const OPERATOR = "22222222-2222-4222-8222-222222222222";
const PLAYER = "66666666-6666-4666-8666-666666666666";
const QUEST = "77777777-7777-4777-8777-777777777777";
const SUBJECT = { username: "sara", avatar: "falcon" };

const row = (fields: Readonly<Record<string, unknown>>) => ({
  outcome: "refused",
  points: null,
  occurrence: null,
  refusal: null,
  refusal_detail: null,
  ...fields,
});

/** The database answering the practice call with `answer` and naming the scanned player. */
function database(answer: Readonly<Record<string, unknown>>) {
  return fakePool((sql): FakeAnswer => {
    if (sql.includes("operator_practice_scan")) {
      return { rows: [row(answer)] };
    }
    return { rows: sql.includes("operator_scan_subject") ? [SUBJECT] : [] };
  });
}

function recordingCaller() {
  const logs: Readonly<{ event: string; fields: Readonly<Record<string, string>> }>[] = [];
  const caller: Caller = {
    address: "127.0.0.1",
    userAgent: null,
    log: (event, fields) => {
      logs.push({ event, fields: fields as Record<string, string> });
    },
  };
  return { caller, logs };
}

const request = (code = myCode(KEY, PLAYER, 1)) => ({ operatorId: OPERATOR, questId: QUEST, code });

describe("practiceScan (FR-929, ADR-249)", () => {
  it("answers green with the would-be points and occurrence, and only calls the practice door", async () => {
    const { pool, queries } = database({ outcome: "completed", points: "30", occurrence: 2 });
    const { caller, logs } = recordingCaller();
    const result = await practiceScan({ pool, myKey: KEY }, request(), caller);
    expect(result).toEqual({ kind: "completed", player: SUBJECT, points: 30, occurrence: 2 });
    expect(queries.some((sql) => sql.includes("operator_complete_quest"))).toBe(false);
    expect(queries[0]).toContain("operator_practice_scan($1, $2, $3)");
    expect(logs).toEqual([
      { event: "operator.practice_scan", fields: { questId: QUEST, result: "completed" } },
    ]);
    expect(JSON.stringify(logs)).not.toContain(PLAYER);
  });

  it.each([
    ["QD409", null, { kind: "already_completed", player: SUBJECT }],
    ["OA403", null, { kind: "refused", reason: "ability_off", player: SUBJECT }],
    ["OM422", null, { kind: "refused", reason: "old_code", player: SUBJECT }],
    [
      "QN403",
      "event_not_live",
      { kind: "refused", reason: "quest_not_open", detail: "event_not_live", player: SUBJECT },
    ],
    ["PW409", null, { kind: "refused", reason: "going_live", player: SUBJECT }],
    ["OP403", null, { kind: "not_operator" }],
  ])("maps %s as the real scan does", async (refusal, detail, expected) => {
    const { pool } = database({ refusal, refusal_detail: detail });
    const { caller } = recordingCaller();
    expect(await practiceScan({ pool, myKey: KEY }, request(), caller)).toEqual(expected);
  });

  it("logs a refusal by its reason only", async () => {
    const { pool } = database({ refusal: "QC403", refusal_detail: "banned" });
    const { caller, logs } = recordingCaller();
    await practiceScan({ pool, myKey: KEY }, request(), caller);
    expect(logs).toEqual([
      {
        event: "operator.practice_scan",
        fields: { questId: QUEST, result: "refused", reason: "enrollment_inactive" },
      },
    ]);
  });

  it.each(["40P01", "40001", "QK422", "XX000"])(
    "throws an unexpected SQLSTATE %s (a 500), never a red result",
    async (refusal) => {
      const { pool } = database({ refusal });
      const { caller } = recordingCaller();
      await expect(practiceScan({ pool, myKey: KEY }, request(), caller)).rejects.toThrow(refusal);
    },
  );

  it("answers red for a code it cannot open, without asking the database", async () => {
    const { pool, queries } = database({ outcome: "completed", points: "30", occurrence: 1 });
    const { caller, logs } = recordingCaller();
    const result = await practiceScan(
      { pool, myKey: KEY },
      request(myCode(createMyCodeKey("x".repeat(40)), PLAYER, 1)),
      caller,
    );
    expect(result).toEqual({ kind: "refused", reason: "invalid_code", player: null });
    expect(queries).toEqual([]);
    expect(logs[0]?.fields).toEqual({ questId: QUEST, result: "refused", reason: "invalid_code" });
  });
});
