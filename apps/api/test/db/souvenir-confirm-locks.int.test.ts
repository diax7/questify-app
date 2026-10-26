import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withRequestContext } from "#src/db/context";
import { TEST_DATABASE_URL } from "#test/support/test-db";
import { blocked, souvenirFixture } from "#test/support/souvenirs";

describe.skipIf(TEST_DATABASE_URL === undefined)(
  "souvenir activation versus final confirmation",
  () => {
    let f: Awaited<ReturnType<typeof souvenirFixture>>;
    let rule: string;
    beforeEach(async () => {
      f = await souvenirFixture();
      await f.db.owner.query(
        "UPDATE event SET rank_prizes=false,status='ended',ends_at=now()-interval '1 minute' WHERE id=$1",
        [f.ids.eventA],
      );
      await f.db.owner.query("UPDATE enrollment SET score=1,score_version=100 WHERE id=$1", [
        f.member,
      ]);
      await f.db.owner.query(
        `WITH made AS (
      INSERT INTO player(username) SELECT 'rank_probe_'||i FROM generate_series(1,19) i RETURNING id,username)
      INSERT INTO enrollment(organizer_id,event_id,player_id,score,score_version)
      SELECT $1,$2,id,30-substring(username from '[0-9]+$')::int,1 FROM made`,
        [f.ids.orgA, f.ids.eventA],
      );
      rule = await f.create({ audience: "rank", rankFrom: 20, rankTo: 20 });
    });
    afterEach(async () => {
      await f.close();
    });
    const places = async () =>
      (
        await f.db.owner.query(
          "SELECT enrollment_id FROM current_places((SELECT e FROM event e WHERE id=$1)) ORDER BY rank",
          [f.ids.eventA],
        )
      ).rows.map((r) => r.enrollment_id);
    const depth = async () =>
      (
        await f.db.owner.query("SELECT result_depth(e) AS n FROM event e WHERE id=$1", [
          f.ids.eventA,
        ])
      ).rows[0].n;
    const counts = async () =>
      (
        await f.db.owner.query(
          `SELECT
    (SELECT count(*)::int FROM result_place WHERE event_id=$1) AS places,
    (SELECT count(*)::int FROM souvenir_receipt WHERE rule_id=$2) AS receipts,
    (SELECT count(*)::int FROM player_item WHERE source_rule_id=$2) AS items`,
          [f.ids.eventA, rule],
        )
      ).rows[0];

    const assertFinalState = async (first: "activation" | "confirmation") => {
      expect(await depth()).toBe(first === "activation" ? 20 : 10);
      if (first === "activation") {
        expect(await counts()).toEqual({ places: 0, receipts: 0, items: 0 });
        const refreshed = await places();
        expect(refreshed).toHaveLength(20);
        expect(
          (
            await f.run(f.actor, "SELECT confirm_results($1,$2,$3) AS outcome", [
              f.ids.eventA,
              refreshed,
              randomUUID(),
            ])
          ).rows[0].outcome,
        ).toBe("confirmed");
        expect((await f.grant()).rows[0].n).toBe(1);
        expect(await counts()).toEqual({ places: 20, receipts: 1, items: 1 });
        expect(
          (
            await f.db.owner.query("SELECT rank FROM result_place WHERE enrollment_id=$1", [
              f.member,
            ])
          ).rows[0].rank,
        ).toBe(20);
      } else {
        expect((await f.grant()).rows[0].n).toBe(0);
        expect(await counts()).toEqual({ places: 10, receipts: 0, items: 0 });
        expect(
          (await f.db.owner.query("SELECT status FROM souvenir_rule WHERE id=$1", [rule])).rows[0]
            .status,
        ).toBe("draft");
      }
      expect((await f.grant()).rows[0].n).toBe(0);
    };

    it.each(["activation", "confirmation"] as const)(
      "%s wins the event lock; the other rechecks the committed boundary",
      async (first) => {
        const winner = await f.pool.connect();
        const loser = await f.pool.connect();
        try {
          for (const client of [winner, loser]) await client.query("SET lock_timeout='5s'");
          const preview = await places();
          expect(preview).toHaveLength(10);
          await winner.query("BEGIN");
          await winner.query(
            "SELECT set_config('app.organizer_id',$1,true),set_config('app.staff_user_id',$2,true)",
            [f.ids.orgA, f.staff],
          );
          if (first === "activation")
            await winner.query("SELECT souvenir_action($1,$2,'activate',$3)", [
              f.ids.eventA,
              rule,
              randomUUID(),
            ]);
          else
            expect(
              (
                await winner.query("SELECT confirm_results($1,$2,$3) AS outcome", [
                  f.ids.eventA,
                  preview,
                  randomUUID(),
                ])
              ).rows[0].outcome,
            ).toBe("confirmed");
          const pid = (await loser.query("SELECT pg_backend_pid() AS id")).rows[0].id;
          const waiting = withRequestContext(loser, f.actor, () =>
            first === "activation"
              ? loser.query("SELECT confirm_results($1,$2,$3)", [
                  f.ids.eventA,
                  preview,
                  randomUUID(),
                ])
              : loser.query("SELECT souvenir_action($1,$2,'activate',$3)", [
                  f.ids.eventA,
                  rule,
                  randomUUID(),
                ]),
          ).then(
            () => ({ code: null, detail: null }),
            (e: { code: string; detail: string }) => ({ code: e.code, detail: e.detail }),
          );
          await blocked(f.db.owner, pid);
          // Neither transaction's uncommitted receipt/snapshot is visible to another connection.
          expect(await counts()).toEqual({ places: 0, receipts: 0, items: 0 });
          await winner.query("COMMIT");
          expect(await waiting).toEqual(
            first === "activation"
              ? { code: "RF409", detail: "results_changed" }
              : { code: "SV409", detail: "results_final" },
          );
          await assertFinalState(first);
        } finally {
          await winner.query("ROLLBACK");
          for (const client of [winner, loser]) {
            await client.query("RESET lock_timeout");
            client.release();
          }
        }
      },
    );
  },
);
