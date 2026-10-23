import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { flagDetail, listFlags, resolveFlag, setFlagHold, setRedeemPause } from "#src/flags/flags";

const EVENT = "33333333-3333-4333-8333-333333333333";
const CONTEXT = {
  organizerId: "11111111-1111-4111-8111-111111111111",
  staffUserId: "22222222-2222-4222-8222-222222222222",
  email: "owner@team.test",
} as const;
const AT = new Date("2030-01-01T10:00:00Z");

type Answer = (sql: string) => Record<string, unknown>[] | Error;

/** A pool whose connection answers each call through `answer`; the transaction statements answer nothing. */
function fakePool(answer: Answer) {
  const statements: { sql: string; values: unknown[] }[] = [];
  const client = {
    query: vi.fn(async (sql: string, values: unknown[] = []) => {
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql) || sql.includes("set_config")) {
        return { rows: [] };
      }
      statements.push({ sql, values });
      const rows = answer(sql);
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

const ROW = {
  id: "7",
  kind: "burst",
  status: "open",
  resolution: null,
  raised_at: AT,
  last_seen_at: AT,
  resolved_at: null,
  enrollment_id: "e1",
  username: "sara_88",
  avatar: "fox",
  accounts: null,
  scans: 10,
  waiting: 2,
};

const LINE = {
  id: "7",
  kind: "burst",
  status: "open",
  resolution: null,
  raisedAt: AT.toISOString(),
  lastSeenAt: AT.toISOString(),
  resolvedAt: null,
  player: { enrollmentId: "e1", username: "sara_88", avatar: "fox" },
  accounts: null,
  scans: 10,
  waiting: 2,
};

const RESOLVE = {
  eventId: EVENT,
  flagId: "7",
  resolution: "cleared",
  note: null,
  requestId: "r1",
} as const;
const HOLD = { eventId: EVENT, on: false, requestId: "r" };
const PAUSE = { eventId: EVENT, enrollmentId: "e1", paused: true, requestId: "r" };

describe("refusals (migration 0031's SQLSTATEs)", () => {
  it.each([
    ["AN404", undefined, { kind: "not_found" }],
    ["FN404", undefined, { kind: "not_found" }],
    ["FN409", "resolved", { kind: "resolved" }],
    ["FN409", "no_removal", { kind: "no_removal" }],
    ["FN409", undefined, { kind: "resolved" }],
    ["FV400", undefined, { kind: "invalid" }],
  ] as const)("answers %s (%s) as its refusal", async (code, detail, expected) => {
    const { deps } = fakePool(() => pgError(code, detail));
    expect(await resolveFlag(deps, CONTEXT, RESOLVE)).toEqual(expected);
  });

  it("throws anything else, with or without a code", async () => {
    const unknown = pgError("XX000");
    await expect(setFlagHold(fakePool(() => unknown).deps, CONTEXT, HOLD)).rejects.toBe(unknown);
    const plain = new Error("down");
    await expect(setFlagHold(fakePool(() => plain).deps, CONTEXT, HOLD)).rejects.toBe(plain);
  });
});

describe("listFlags", () => {
  it("sends the page and reads every column and the hold", async () => {
    const { deps, statements } = fakePool((sql) =>
      sql.includes("event_flags")
        ? [ROW, { ...ROW, id: "8", scans: "x", waiting: null, raised_at: "soon" }]
        : [{ flag_hold: false }],
    );
    const done = await listFlags(deps, CONTEXT, {
      eventId: EVENT,
      open: false,
      beforeId: "9",
      limit: 2,
    });
    expect(statements[0]).toEqual({
      sql: "SELECT * FROM event_flags($1, $2, $3, $4)",
      values: [EVENT, false, "9", 2],
    });
    expect(done).toEqual({
      kind: "done",
      value: {
        hold: false,
        flags: [LINE, { ...LINE, id: "8", scans: null, waiting: 0, raisedAt: null }],
      },
    });
  });

  it("reads the hold as on unless it is off, also with no event row", async () => {
    const request = { eventId: EVENT, open: true, beforeId: null, limit: 1 };
    const on = fakePool((sql) => (sql.includes("event_flags") ? [] : [{ flag_hold: true }]));
    expect(await listFlags(on.deps, CONTEXT, request)).toMatchObject({ value: { hold: true } });
    expect(await listFlags(fakePool(() => []).deps, CONTEXT, request)).toMatchObject({
      value: { hold: true, flags: [] },
    });
  });
});

describe("flagDetail", () => {
  it("reads the case, its evidence, waiting items and removals", async () => {
    const { deps, statements } = fakePool(() => [
      {
        ...ROW,
        note: "fast",
        resolved_by: "owner@team.test",
        enrollment_status: "active",
        paused: true,
        hold: true,
        evidence: [{ at: "x" }],
        waiting: [{ nameEn: "Hoodie" }],
        removals: [{ entryId: 1 }],
      },
    ]);
    const done = await flagDetail(deps, CONTEXT, { eventId: EVENT, flagId: "7" });
    expect(statements).toEqual([
      { sql: "SELECT * FROM flag_detail($1, $2)", values: [EVENT, "7"] },
    ]);
    expect(done).toEqual({
      kind: "done",
      value: {
        ...LINE,
        scans: null,
        waiting: 1,
        note: "fast",
        resolvedBy: "owner@team.test",
        enrollmentStatus: "active",
        paused: true,
        hold: true,
        evidence: [{ at: "x" }],
        waitingItems: [{ nameEn: "Hoodie" }],
        removals: [{ entryId: 1 }],
      },
    });
  });

  it("answers null for no case, and empty lists and falses for missing parts", async () => {
    const request = { eventId: EVENT, flagId: "7" };
    expect(await flagDetail(fakePool(() => []).deps, CONTEXT, request)).toEqual({
      kind: "done",
      value: null,
    });
    const odd = fakePool(() => [{ ...ROW, waiting: "2", paused: "yes", hold: 1 }]);
    expect(await flagDetail(odd.deps, CONTEXT, request)).toMatchObject({
      value: {
        note: null,
        resolvedBy: null,
        paused: false,
        hold: false,
        evidence: [],
        waitingItems: [],
        removals: [],
        waiting: 0,
      },
    });
  });
});

describe("resolveFlag and the owner's switches", () => {
  it("sends the resolution and answers the case's new state", async () => {
    const { deps, statements } = fakePool(() => [
      { status: "confirmed", resolution: "points_removed" },
    ]);
    expect(
      await resolveFlag(deps, CONTEXT, { ...RESOLVE, resolution: "points_removed", note: "n" }),
    ).toEqual({ kind: "done", value: { status: "confirmed", resolution: "points_removed" } });
    expect(statements).toEqual([
      {
        sql: "SELECT status, resolution FROM resolve_flag($1, $2, $3, $4, $5)",
        values: [EVENT, "7", "points_removed", "n", "r1"],
      },
    ]);
  });

  it("throws when the database answers no row", async () => {
    await expect(resolveFlag(fakePool(() => []).deps, CONTEXT, RESOLVE)).rejects.toThrow(
      "resolve_flag answered no row",
    );
  });

  it("sends the pause and the hold, and reads their outcomes", async () => {
    const pause = fakePool(() => [{ outcome: "changed" }]);
    expect(await setRedeemPause(pause.deps, CONTEXT, PAUSE)).toEqual({
      kind: "done",
      value: "changed",
    });
    expect(pause.statements).toEqual([
      {
        sql: "SELECT set_redeem_pause($1, $2, $3, $4) AS outcome",
        values: [EVENT, "e1", true, "r"],
      },
    ]);
    const hold = fakePool(() => [{ outcome: "not_owner" }]);
    expect(await setFlagHold(hold.deps, CONTEXT, HOLD)).toEqual({
      kind: "done",
      value: "not_owner",
    });
    expect(hold.statements).toEqual([
      { sql: "SELECT set_flag_hold($1, $2, $3) AS outcome", values: [EVENT, false, "r"] },
    ]);
    expect(await setFlagHold(fakePool(() => []).deps, CONTEXT, HOLD)).toEqual({
      kind: "done",
      value: "not_found",
    });
    expect(await setRedeemPause(fakePool(() => []).deps, CONTEXT, PAUSE)).toEqual({
      kind: "done",
      value: "not_found",
    });
  });
});
