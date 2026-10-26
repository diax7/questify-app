import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { paySouvenirs } from "#src/souvenirs/payer";
import { withRequestContext } from "#src/db/context";
import { TEST_DATABASE_URL } from "#test/support/test-db";
import { blocked, souvenirFixture } from "#test/support/souvenirs";

describe.skipIf(TEST_DATABASE_URL === undefined)("souvenir new-door matrix", () => {
  let f: Awaited<ReturnType<typeof souvenirFixture>>;
  beforeEach(async () => {
    f = await souvenirFixture();
  });
  afterEach(async () => {
    await f.close();
  });
  const counts = async () =>
    (
      await f.db.owner.query(
        "SELECT (SELECT count(*)::int FROM souvenir_receipt) AS receipts,(SELECT count(*)::int FROM player_item WHERE source='souvenir') AS items",
      )
    ).rows[0];
  const drain = () => paySouvenirs({ pool: f.pool }, { eventId: f.ids.eventA, budgetMs: 5000 });

  it.each(["category", "all"])(
    "finished zero-right quiz grants the %s souvenir through automatic work",
    async (audience) => {
      await f.db.owner.query("UPDATE quest SET type='quiz',type_config=$2 WHERE id=$1", [
        f.quest,
        {
          questions: [
            {
              id: "q1",
              text: { en: "Question" },
              choices: [
                { id: "r", text: { en: "Right" } },
                { id: "w", text: { en: "Wrong" } },
              ],
              right: "r",
            },
          ],
          timerSeconds: null,
        },
      ]);
      const rule = await f.create({
        audience,
        categoryId: audience === "category" ? f.category : null,
      });
      await f.action(rule);
      await drain();
      expect(await counts()).toEqual({ receipts: 0, items: 0 });
      await f.run({ playerId: f.ids.playerA }, "SELECT quiz_start($1)", [f.quest]);
      await f.run({ playerId: f.ids.playerA }, "SELECT quiz_next($1)", [f.quest]);
      await f.run({ playerId: f.ids.playerA }, "SELECT quiz_answer($1,'q1','w')", [f.quest]);
      expect(
        (await f.db.owner.query("SELECT status,right_count,completion_id FROM quiz_attempt"))
          .rows[0],
      ).toMatchObject({ status: "finished", right_count: 0, completion_id: null });
      expect(
        (await f.db.owner.query("SELECT count(*)::int AS n FROM souvenir_work")).rows[0].n,
      ).toBe(1);
      expect((await drain()).granted).toBe(1);
      expect(await counts()).toEqual({ receipts: 1, items: 1 });
      expect((await drain()).granted).toBe(0);
      expect(
        (await f.db.owner.query("SELECT count(*)::int AS n FROM quest_completion")).rows[0].n,
      ).toBe(0);
    },
  );

  it.each(["exhausted", "open", "unlimited"])(
    "automatic all-quest evaluator handles %s games",
    async (state) => {
      await f.db.owner.query("UPDATE quest SET type='game',type_config=$2 WHERE id=$1", [
        f.quest,
        {
          game: "memory_match",
          level: "easy",
          attempts: state === "unlimited" ? null : 1,
          cooldownMinutes: state === "unlimited" ? 1 : null,
        },
      ]);
      const rule = await f.create({ audience: "all" });
      await f.action(rule);
      await drain();
      const round = (
        await f.run({ playerId: f.ids.playerA }, "SELECT * FROM start_game_round($1,$2,NULL,1)", [
          f.quest,
          randomUUID(),
        ])
      ).rows[0];
      // Issuance alone is not a terminal fact, even when the last attempt has been consumed.
      await f.db.owner.query("UPDATE enrollment SET waitlisted=waitlisted WHERE id=$1", [f.member]);
      expect((await drain()).granted).toBe(0);
      expect(await counts()).toEqual({ receipts: 0, items: 0 });
      if (state !== "open") {
        await f.run(
          { playerId: f.ids.playerA },
          "SELECT * FROM finish_game_round($1,$2,'short',$3,NULL,false,0)",
          [round.round_id, randomUUID(), { pairs: 4, moves: 30, ms: 120000, lucky: 0 }],
        );
        expect(
          (await f.db.owner.query("SELECT count(*)::int AS n FROM souvenir_work")).rows[0].n,
        ).toBe(1);
      }
      const expected = state === "exhausted" ? 1 : 0;
      expect((await drain()).granted).toBe(expected);
      expect(await counts()).toEqual({ receipts: expected, items: expected });
      expect(
        (await f.db.owner.query("SELECT count(*)::int AS n FROM quest_completion")).rows[0].n,
      ).toBe(0);
      expect((await f.grant()).rows[0].n).toBe(0);
    },
  );

  it("completion waiting after its queue write cannot cycle with grant or an older acknowledgment", async () => {
    // The joined promise is owed before the completion commits, so the evaluator passes its unlocked pre-check and
    // takes the grant locks behind the waiting completion instead of returning early.
    await f.action(await f.create());
    const rule = await f.create({ audience: "all" });
    await f.action(rule);
    await f.run({}, "SELECT souvenir_scan_batch($1)", [f.ids.eventA]);
    const claim = (await f.run({}, "SELECT * FROM souvenir_claim_work($1,1)", [f.ids.eventA]))
      .rows[0];
    const completion = await f.pool.connect();
    const evaluator = await f.pool.connect();
    const ack = await f.pool.connect();
    try {
      for (const client of [completion, evaluator, ack])
        await client.query("SET lock_timeout='5s'");
      await f.db.owner.query("BEGIN");
      await f.db.owner.query("SET LOCAL lock_timeout='5s'");
      await f.db.owner.query("SELECT 1 FROM player_xp WHERE player_id=$1 FOR UPDATE", [
        f.ids.playerA,
      ]);
      const cp = (await completion.query("SELECT pg_backend_pid() AS id")).rows[0].id;
      const completing = withRequestContext(completion, { playerId: f.ids.playerA }, () =>
        completion.query("SELECT * FROM complete_quest($1,'code',NULL,'ABC',$2,NULL)", [
          f.quest,
          randomUUID(),
        ]),
      );
      await blocked(evaluator, cp);
      // The completion owns the queue row before waiting for XP: old ack must wait behind that write.
      const ap = (await ack.query("SELECT pg_backend_pid() AS id")).rows[0].id;
      const acknowledging = withRequestContext(ack, {}, () =>
        ack.query("SELECT souvenir_ack($1,$2,$3,NULL)", [
          f.member,
          claim.generation,
          claim.lease_token,
        ]),
      );
      await blocked(evaluator, ap);
      const ep = (await evaluator.query("SELECT pg_backend_pid() AS id")).rows[0].id;
      const granting = withRequestContext(evaluator, {}, () =>
        evaluator.query("SELECT souvenir_evaluate($1) AS n", [f.member]),
      );
      // A fourth, unlocked connection observes both wait chains without joining either transaction.
      const observer = await f.pool.connect();
      try {
        await blocked(observer, ep);
      } finally {
        observer.release();
      }
      await f.db.owner.query("COMMIT");
      await completing;
      await acknowledging;
      expect((await granting).rows[0].n).toBe(2);
      expect(await counts()).toEqual({ receipts: 2, items: 2 });
      const pending = (
        await f.db.owner.query("SELECT generation FROM souvenir_work WHERE enrollment_id=$1", [
          f.member,
        ])
      ).rows[0];
      expect(Number(pending.generation)).toBeGreaterThan(Number(claim.generation));
      await drain();
      expect(
        (await f.db.owner.query("SELECT count(*)::int AS n FROM souvenir_work")).rows[0].n,
      ).toBe(0);
      expect(await counts()).toEqual({ receipts: 2, items: 2 });
    } finally {
      await f.db.owner.query("ROLLBACK");
      for (const client of [completion, evaluator, ack]) {
        await client.query("RESET lock_timeout");
        client.release();
      }
    }
  });

  it("with only an every-quest promise, the evaluator returns at once while the older ack waits", async () => {
    await f.action(await f.create({ audience: "all" }));
    await f.run({}, "SELECT souvenir_scan_batch($1)", [f.ids.eventA]);
    const claim = (await f.run({}, "SELECT * FROM souvenir_claim_work($1,1)", [f.ids.eventA]))
      .rows[0];
    const completion = await f.pool.connect();
    const evaluator = await f.pool.connect();
    const ack = await f.pool.connect();
    try {
      for (const client of [completion, evaluator, ack])
        await client.query("SET lock_timeout='5s'");
      await f.db.owner.query("BEGIN");
      await f.db.owner.query("SET LOCAL lock_timeout='5s'");
      await f.db.owner.query("SELECT 1 FROM player_xp WHERE player_id=$1 FOR UPDATE", [
        f.ids.playerA,
      ]);
      const cp = (await completion.query("SELECT pg_backend_pid() AS id")).rows[0].id;
      const completing = withRequestContext(completion, { playerId: f.ids.playerA }, () =>
        completion.query("SELECT * FROM complete_quest($1,'code',NULL,'ABC',$2,NULL)", [
          f.quest,
          randomUUID(),
        ]),
      );
      await blocked(evaluator, cp);
      const ap = (await ack.query("SELECT pg_backend_pid() AS id")).rows[0].id;
      const acknowledging = withRequestContext(ack, {}, () =>
        ack.query("SELECT souvenir_ack($1,$2,$3,NULL)", [
          f.member,
          claim.generation,
          claim.lease_token,
        ]),
      );
      await blocked(evaluator, ap);
      // The uncommitted completion is invisible to the unlocked pre-check: no lock is taken, nothing waits.
      const granted = await withRequestContext(evaluator, {}, () =>
        evaluator.query("SELECT souvenir_evaluate($1) AS n", [f.member]),
      );
      expect(granted.rows[0].n).toBe(0);
      await blocked(evaluator, ap);
      await f.db.owner.query("COMMIT");
      await completing;
      await acknowledging;
      const pending = (
        await f.db.owner.query("SELECT generation FROM souvenir_work WHERE enrollment_id=$1", [
          f.member,
        ])
      ).rows[0];
      expect(Number(pending.generation)).toBeGreaterThan(Number(claim.generation));
      expect((await drain()).granted).toBe(1);
      expect(
        (await f.db.owner.query("SELECT count(*)::int AS n FROM souvenir_work")).rows[0].n,
      ).toBe(0);
      expect(await counts()).toEqual({ receipts: 1, items: 1 });
    } finally {
      await f.db.owner.query("ROLLBACK");
      for (const client of [completion, evaluator, ack]) {
        await client.query("RESET lock_timeout");
        client.release();
      }
    }
  });
});
