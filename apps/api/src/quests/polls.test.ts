import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { closePoll, sendPoll } from "#src/quests/polls";

/** A pool whose send or close statement fails with `failure`; the transaction statements pass. */
function failingPool(failure: unknown) {
  const client = {
    query: vi.fn(async (sql: string) => {
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql) || sql.includes("set_config")) {
        return { rows: [] };
      }
      throw failure;
    }),
    release: vi.fn(),
  };
  return { pool: { connect: async () => client } as unknown as Pool };
}

const pgError = (code?: string, detail?: string) =>
  Object.assign(new Error("database refusal"), { code, detail });
const CONTEXT = {
  organizerId: "11111111-1111-4111-8111-111111111111",
  staffUserId: "22222222-2222-4222-8222-222222222222",
};
const TARGET = {
  eventId: "33333333-3333-4333-8333-333333333333",
  questId: "44444444-4444-4444-8444-444444444444",
  requestId: "req-1",
};

describe("sendPoll and closePoll refusals", () => {
  it.each([
    [pgError("AN404"), { kind: "not_found" }],
    [pgError("PN422"), { kind: "not_live_poll" }],
    [pgError("PE409"), { kind: "event_not_live" }],
    [pgError("PS409", "already_sent"), { kind: "already_sent" }],
    [pgError("PS409", "not_sent"), { kind: "not_sent" }],
    [pgError("PL409", "community_locked"), { kind: "community_locked" }],
  ])("answers %o as %o", async (error, expected) => {
    expect(await sendPoll(failingPool(error), CONTEXT, TARGET)).toEqual(expected);
    expect(await closePoll(failingPool(error), CONTEXT, TARGET)).toEqual(expected);
  });

  it.each([
    pgError("PS409", "other"),
    pgError("PS409"),
    pgError("PL409", "other"),
    pgError("XX000"),
    pgError(),
  ])("throws anything else as it came: %o", async (error) => {
    await expect(sendPoll(failingPool(error), CONTEXT, TARGET)).rejects.toBe(error);
  });
});
