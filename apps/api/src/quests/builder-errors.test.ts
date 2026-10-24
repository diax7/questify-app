import { describe, expect, it } from "vitest";
import type { Actor } from "#src/events/events";
import { withEvent } from "#src/quests/builder";
import { fakePool, pgError } from "#test/support/fake-pool";

const ACTOR = {
  organizerId: "11111111-1111-4111-8111-111111111111",
  staffUserId: "22222222-2222-4222-8222-222222222222",
} as Actor;
const EVENT = "33333333-3333-4333-8333-333333333333";

/** A builder write on a live event whose work fails as the database would fail it. */
function failingWith(error: Error) {
  const { pool } = fakePool((sql) => {
    if (sql.includes("FOR NO KEY UPDATE")) {
      return { rows: [{ id: EVENT, timezone: "Asia/Riyadh", status_now: "live" }] };
    }
    throw new Error(`unexpected query: ${sql}`);
  });
  return withEvent({ pool }, ACTOR, EVENT, { change: undefined }, async () => {
    throw error;
  });
}

/**
 * The builder's answers to the database's refusals that only a race reaches (the builder checks each first): another
 * write between the check and the write, or a player playing between them.
 */
describe("the builder's answer to a refusal raised mid-write", () => {
  it("names the field or the reason the database refused", async () => {
    expect(await failingWith(pgError({ code: "QT422" }))).toEqual({
      kind: "invalid",
      field: "refresh",
    });
    expect(await failingWith(pgError({ code: "QI422" }))).toEqual({ kind: "invalid_item" });
    expect(await failingWith(pgError({ code: "CU422" }))).toEqual({
      kind: "invalid",
      field: "unlockAfter",
    });
  });

  it("calls a quest played between the check and its delete played, and a stamped step in use", async () => {
    for (const table of ["quest_completion", "submission", "quest_item_miss"]) {
      expect(await failingWith(pgError({ code: "23503", table })), table).toEqual({
        kind: "has_completions",
      });
    }
    expect(await failingWith(pgError({ code: "23503", table: "passport_stamp" }))).toEqual({
      kind: "step_in_use",
    });
  });

  it("lets any other error through, as an error", async () => {
    for (const error of [
      pgError({ code: "23503" }),
      pgError({ code: "23503", table: "event" }),
      pgError({ code: "23505", table: "quest_completion" }),
      pgError({ code: "23505", table: "passport_stamp" }),
      pgError({ code: "XX000" }),
    ]) {
      await expect(failingWith(error)).rejects.toBe(error);
    }
  });
});
