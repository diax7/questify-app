import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { BATCH_SIZE, payBatches, settleAndPay } from "#src/community/payer";

type Answer = (sql: string) => Record<string, unknown>[] | Error;

/** A pool whose connection answers each statement through `answer`, keeping the statements and their values. */
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
  return { pool: { connect: async () => client } as unknown as Pool, statements };
}

const pgError = (code: string) => Object.assign(new Error("database refusal"), { code });
const settingsOn = { forEvent: vi.fn(async () => ({ kind: "ok", config: { features: {} } })) };
const CONTEXT = {
  organizerId: "11111111-1111-4111-8111-111111111111",
  staffUserId: "22222222-2222-4222-8222-222222222222",
};
const REQUEST = { eventId: "33333333-3333-4333-8333-333333333333", requestId: "req-1" };

describe("payBatches", () => {
  it("pays only the given event's rewards when one is named, and every event's otherwise", async () => {
    const one = fakePool(() => []);
    expect(await payBatches(one.pool, { budgetMs: 1000, onlyEvent: REQUEST.eventId })).toEqual({
      batches: 0,
      paid: 0,
      skipped: 0,
    });
    expect(one.statements.map((statement) => statement.values)).toEqual([
      [BATCH_SIZE, REQUEST.eventId],
    ]);
    const all = fakePool(() => []);
    await payBatches(all.pool, { budgetMs: 1000 });
    expect(all.statements.map((statement) => statement.values)).toEqual([[BATCH_SIZE, null]]);
  });
});

const settle = (answer: Answer) =>
  settleAndPay({ pool: fakePool(answer).pool, settings: settingsOn as never }, CONTEXT, REQUEST);

describe("settleAndPay", () => {
  it("answers the goals and rewards still left, paying while any is due", async () => {
    expect(
      await settle((sql) => (sql.includes("community_paying") ? [{ goals: "2", due: "3" }] : [])),
    ).toEqual({ kind: "done", value: { status: "paying", goals: 2, due: 3 } });
    expect(
      await settle((sql) => (sql.includes("community_paying") ? [{ goals: "1", due: "0" }] : [])),
    ).toEqual({ kind: "done", value: { status: "paid", goals: 1, due: 0 } });
  });

  it("answers nothing left when the count comes back empty", async () => {
    expect(await settle(() => [])).toEqual({
      kind: "done",
      value: { status: "paid", goals: 0, due: 0 },
    });
  });

  it("answers the refusal of the settle, and of the count after paying", async () => {
    expect(
      await settle((sql) => (sql.includes("settle_community") ? pgError("CO403") : [])),
    ).toEqual({ kind: "owner_only" });
    expect(
      await settle((sql) => (sql.includes("community_paying") ? pgError("CS409") : [])),
    ).toEqual({ kind: "settling" });
  });
});
