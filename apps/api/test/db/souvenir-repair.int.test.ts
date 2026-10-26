import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withRequestContext } from "#src/db/context";
import { paySouvenirs } from "#src/souvenirs/payer";
import { TEST_DATABASE_URL } from "#test/support/test-db";
import { souvenirFixture } from "#test/support/souvenirs";

/** ADR-272: one finite pass per activation or /process request; fact triggers deliver everything after it. */
describe.skipIf(TEST_DATABASE_URL === undefined)("souvenir finite repair passes", () => {
  let f: Awaited<ReturnType<typeof souvenirFixture>>;
  beforeEach(async () => {
    f = await souvenirFixture();
  });
  afterEach(async () => {
    await f.close();
  });
  const count = async (sql: string, values: unknown[] = []) =>
    Number((await f.db.owner.query(sql, values)).rows[0].n);
  const work = () => count("SELECT count(*) AS n FROM souvenir_work");
  const scans = () => count("SELECT count(*) AS n FROM souvenir_scan");
  const receipts = (rule: string) =>
    count("SELECT count(*) AS n FROM souvenir_receipt WHERE rule_id=$1", [rule]);
  const drain = () => paySouvenirs({ pool: f.pool }, { eventId: f.ids.eventA, budgetMs: 10_000 });
  const status = async () =>
    (await f.run(f.actor, "SELECT souvenir_list($1) AS v", [f.ids.eventA])).rows[0].v as {
      due: number;
      scanning: number;
    };
  /** Real members ranked by score: the last added scores highest. */
  const addMembers = async (total: number) =>
    (
      await f.db.owner.query(
        `WITH made AS (
          INSERT INTO player(username) SELECT 'repair_'||i FROM generate_series(1,$3::int) i RETURNING id,username)
        INSERT INTO enrollment(organizer_id,event_id,player_id,score,score_version)
        SELECT $1,$2,id,substring(username from '[0-9]+$')::int,1 FROM made RETURNING id,player_id`,
        [f.ids.orgA, f.ids.eventA, total],
      )
    ).rows as { id: string; player_id: string }[];
  const confirm = async () => {
    await f.db.owner.query(
      "UPDATE event SET status='ended',ends_at=now()-interval '1 minute' WHERE id=$1",
      [f.ids.eventA],
    );
    const places = (
      await f.db.owner.query(
        "SELECT enrollment_id FROM current_places((SELECT e FROM event e WHERE id=$1)) ORDER BY rank",
        [f.ids.eventA],
      )
    ).rows.map((r) => r.enrollment_id);
    return f.run(f.actor, "SELECT confirm_results($1,$2,$3) AS outcome", [
      f.ids.eventA,
      places,
      randomUUID(),
    ]);
  };

  it("drains rank and category rules most members miss once, then never re-enqueues them", async () => {
    await addMembers(30);
    await f.complete();
    const category = await f.create({ audience: "category", categoryId: f.category });
    const rank = await f.create({ audience: "rank", rankFrom: 1, rankTo: 1 });
    await f.action(category);
    await f.action(rank);
    // The rank rule has no confirmed place to find: its result_place trigger delivers instead of a pass.
    expect(await count("SELECT count(*) AS n FROM souvenir_scan WHERE rule_id=$1", [rank])).toBe(0);
    expect(await drain()).toEqual({ granted: 1, skipped: 30, failed: 0 });
    expect([await receipts(category), await receipts(rank), await scans(), await work()]).toEqual([
      1, 0, 0, 0,
    ]);
    // Past the window the old repeating sweep waited: nothing is due, scanned or evaluated again.
    await f.db.owner.query("UPDATE souvenir_scan SET next_at=next_at-interval '2 minutes'");
    await f.db.owner.query("UPDATE souvenir_work SET ready_at=ready_at-interval '2 minutes'");
    expect((await f.run({}, "SELECT souvenir_scan_batch($1) AS n", [f.ids.eventA])).rows[0].n).toBe(
      0,
    );
    expect(await drain()).toEqual({ granted: 0, skipped: 0, failed: 0 });
    expect(await work()).toBe(0);
    expect(await status()).toMatchObject({ due: 0, scanning: 0 });
    // Confirmation enqueues only the placed members; the top place alone earns the rank souvenir.
    expect((await confirm()).rows[0].outcome).toBe("confirmed");
    expect(await work()).toBe(10);
    expect(await drain()).toEqual({ granted: 1, skipped: 9, failed: 0 });
    expect([await receipts(rank), await scans(), await work()]).toEqual([1, 0, 0]);
    expect(await status()).toMatchObject({ due: 0, scanning: 0 });
  });

  it("runs one more finite pass for /process on a finished scan, and a replayed key adds none", async () => {
    await addMembers(5);
    const category = await f.create({ audience: "category", categoryId: f.category });
    await f.action(category);
    await drain();
    expect(await scans()).toBe(0);
    const key = randomUUID();
    await f.run(f.actor, "SELECT souvenir_request($1,$2)", [f.ids.eventA, key]);
    expect(await scans()).toBe(1);
    expect(await status()).toMatchObject({ scanning: 1 });
    await f.complete();
    expect(await drain()).toEqual({ granted: 1, skipped: 5, failed: 0 });
    expect([await scans(), await work(), await receipts(category)]).toEqual([0, 0, 1]);
    await f.run(f.actor, "SELECT souvenir_request($1,$2)", [f.ids.eventA, key]);
    expect(await scans()).toBe(0);
    expect(await count("SELECT count(*) AS n FROM audit_log WHERE action='souvenir.process'")).toBe(
      1,
    );
    expect(await status()).toMatchObject({ due: 0, scanning: 0 });
  });

  it("holds an activation pass until the event goes live, then grants every member once", async () => {
    await addMembers(3);
    await f.db.owner.query(
      "UPDATE event SET status='scheduled',starts_at=now()+interval '1 hour' WHERE id=$1",
      [f.ids.eventA],
    );
    const joined = await f.create();
    await f.action(joined);
    expect(await drain()).toEqual({ granted: 0, skipped: 0, failed: 0 });
    expect(await scans()).toBe(1);
    expect(await status()).toMatchObject({ due: 0, scanning: 0 });
    await f.db.owner.query("UPDATE event SET starts_at=now()-interval '1 second' WHERE id=$1", [
      f.ids.eventA,
    ]);
    expect(await status()).toMatchObject({ scanning: 1 });
    expect(await drain()).toEqual({ granted: 4, skipped: 0, failed: 0 });
    expect([await receipts(joined), await scans(), await work()]).toEqual([4, 0, 0]);
  });

  it("enqueues an operator allowed to play or removed, and a reinstated account", async () => {
    const [other, banned] = (await addMembers(2)).map((member) => member.player_id);
    if (other === undefined || banned === undefined) throw new Error("expected two new members");
    await f.run({ playerId: other }, "SELECT * FROM complete_quest($1,'code',NULL,'ABC',$2,NULL)", [
      f.quest,
      randomUUID(),
    ]);
    await f.complete();
    const staffed = async (player: string) =>
      (
        await f.db.owner.query(
          "INSERT INTO staff_assignment(organizer_id,event_id,player_id) VALUES($1,$2,$3) RETURNING id",
          [f.ids.orgA, f.ids.eventA, player],
        )
      ).rows[0].id as string;
    const mine = await staffed(f.ids.playerA);
    const theirs = await staffed(other);
    await f.run({ isAdmin: true }, "UPDATE player SET status='banned' WHERE id=$1", [banned]);
    const finishers = await f.create({ audience: "all" });
    const joined = await f.create();
    await f.action(finishers);
    await f.action(joined);
    await drain();
    expect([await receipts(finishers), await receipts(joined), await work()]).toEqual([0, 2, 0]);
    expect(
      (
        await f.run(f.actor, "SELECT set_operator($1,$2,$3,true,$4,$5) AS outcome", [
          f.ids.eventA,
          mine,
          ["scan_quests"],
          [],
          randomUUID(),
        ])
      ).rows[0].outcome,
    ).toBe("changed");
    expect(
      (
        await f.run(f.actor, "SELECT remove_operator($1,$2,$3) AS outcome", [
          f.ids.eventA,
          theirs,
          randomUUID(),
        ])
      ).rows[0].outcome,
    ).toBe("removed");
    await f.run({ isAdmin: true }, "UPDATE player SET status='active' WHERE id=$1", [banned]);
    expect(await work()).toBe(3);
    expect(await drain()).toEqual({ granted: 3, skipped: 0, failed: 0 });
    expect([await receipts(finishers), await receipts(joined), await work()]).toEqual([2, 3, 0]);
  });

  it("fires every souvenir enqueue before the ranking mark on the same table (name order)", async () => {
    const { rows } = await f.db.owner.query(
      `SELECT c.relname AS table, t.tgname AS name FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
       WHERE NOT t.tgisinternal AND (t.tgname LIKE 'enqueue_souvenir_%' OR (t.tgname LIKE 'mark_ranking_%'
         AND c.relname IN ('enrollment','game_round','player','quest_completion','quiz_attempt','result_place','staff_assignment')))
       ORDER BY c.relname, t.tgname::text COLLATE "C"`,
    );
    expect(rows.map((row) => `${row.table}.${row.name}`)).toEqual([
      "enrollment.enqueue_souvenir_on_join",
      "enrollment.mark_ranking_on_enrollment",
      "game_round.enqueue_souvenir_on_game",
      "player.enqueue_souvenir_on_reinstate",
      "player.mark_ranking_on_player",
      "quest_completion.enqueue_souvenir_on_complete",
      "quiz_attempt.enqueue_souvenir_on_quiz",
      "result_place.enqueue_souvenir_on_results",
      "staff_assignment.enqueue_souvenir_on_staff",
      "staff_assignment.mark_ranking_on_assignment",
    ]);
  });

  it("erases an operator's queued work although deleting their assignment enqueues it", async () => {
    await f.db.owner.query(
      "INSERT INTO staff_assignment(organizer_id,event_id,player_id) VALUES($1,$2,$3)",
      [f.ids.orgA, f.ids.eventA, f.ids.playerA],
    );
    await f.action(await f.create({ audience: "category", categoryId: f.category }));
    const token = await f.deletion();
    expect(
      (await f.run({}, "SELECT * FROM erase_player($1,true,$2)", [token, randomUUID()])).rows[0]
        .outcome,
    ).toBe("erased");
    expect(
      await count("SELECT count(*) AS n FROM souvenir_work WHERE enrollment_id=$1", [f.member]),
    ).toBe(0);
  });

  it("evaluates a member owed nothing without waiting on held player, enrollment or XP locks", async () => {
    const category = await f.create({ audience: "category", categoryId: f.category });
    await f.action(category);
    const evaluator = await f.pool.connect();
    try {
      await f.db.owner.query("BEGIN");
      await f.db.owner.query("SELECT 1 FROM player WHERE id=$1 FOR UPDATE", [f.ids.playerA]);
      await f.db.owner.query("SELECT 1 FROM enrollment WHERE id=$1 FOR UPDATE", [f.member]);
      await f.db.owner.query("SELECT 1 FROM player_xp WHERE player_id=$1 FOR UPDATE", [
        f.ids.playerA,
      ]);
      await evaluator.query("SET lock_timeout='1s'");
      const made = await withRequestContext(evaluator, {}, () =>
        evaluator.query("SELECT souvenir_evaluate($1) AS n", [f.member]),
      );
      expect(made.rows[0].n).toBe(0);
    } finally {
      await f.db.owner.query("ROLLBACK");
      await evaluator.query("RESET lock_timeout");
      evaluator.release();
    }
  });

  it("re-enqueues waiting work without moving it behind newer rows", async () => {
    const joined = await f.create();
    await f.action(joined);
    await f.run({}, "SELECT souvenir_scan_batch($1)", [f.ids.eventA]);
    await f.db.owner.query("UPDATE souvenir_work SET ready_at=now()-interval '1 hour'");
    await f.db.owner.query("UPDATE enrollment SET waitlisted=waitlisted WHERE id=$1", [f.member]);
    const row = (
      await f.db.owner.query(
        "SELECT generation,ready_at<now()-interval '59 minutes' AS kept FROM souvenir_work",
      )
    ).rows[0];
    expect([Number(row.generation), row.kept]).toEqual([2, true]);
  });

  it("releases claims a spent budget left unevaluated, due again at once and uncounted", async () => {
    await addMembers(3);
    const joined = await f.create();
    await f.action(joined);
    let clock = 0;
    const totals = await paySouvenirs(
      { pool: f.pool },
      {
        eventId: f.ids.eventA,
        budgetMs: 2500,
        now: () => {
          clock += 1000;
          return clock;
        },
      },
    );
    expect(totals).toEqual({ granted: 1, skipped: 0, failed: 0 });
    const left = (
      await f.db.owner.query("SELECT lease_token,lease_until,attempts FROM souvenir_work")
    ).rows;
    expect(left).toEqual(
      Array.from({ length: 3 }, () => ({ lease_token: null, lease_until: null, attempts: 0 })),
    );
    expect(
      (await f.run({}, "SELECT * FROM souvenir_claim_work($1,20)", [f.ids.eventA])).rows,
    ).toHaveLength(3);
    await expect(
      f.run(f.actor, "SELECT souvenir_release($1,$2)", [[f.member], [randomUUID()]]),
    ).rejects.toMatchObject({ code: "SV403" });
  });
});
