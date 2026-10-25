import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TEST_DATABASE_URL } from "#test/support/test-db";
import { blocked, souvenirFixture } from "#test/support/souvenirs";
import { withRequestContext } from "#src/db/context";

describe.skipIf(TEST_DATABASE_URL === undefined)("souvenir serialization", () => {
  let f: Awaited<ReturnType<typeof souvenirFixture>>;
  beforeEach(async () => {
    f = await souvenirFixture();
    const rule = await f.create();
    await f.action(rule);
  });
  afterEach(async () => {
    await f.close();
  });

  it("admin ban first blocks the evaluator, which refuses the committed banned row", async () => {
    const admin = await f.pool.connect();
    const evaluator = await f.pool.connect();
    try {
      await admin.query("BEGIN");
      await admin.query("SELECT set_config('app.is_admin','on',true)");
      await admin.query("UPDATE player SET status='banned' WHERE id=$1", [f.ids.playerA]);
      const pid = (await evaluator.query("SELECT pg_backend_pid() AS id")).rows[0].id;
      const granting = withRequestContext(evaluator, {}, () =>
        evaluator.query("SELECT souvenir_evaluate($1) AS n", [f.member]),
      );
      await blocked(f.db.owner, pid);
      await admin.query("COMMIT");
      expect((await granting).rows[0].n).toBe(0);
      expect((await f.owned()).rows).toEqual([]);
    } finally {
      await admin.query("ROLLBACK");
      admin.release();
      evaluator.release();
    }
  });
  it("evaluator first holds SHARE through grant commit, so the ordinary admin UPDATE waits", async () => {
    const evaluator = await f.pool.connect();
    const admin = await f.pool.connect();
    try {
      await evaluator.query("BEGIN");
      await evaluator.query("SELECT souvenir_evaluate($1)", [f.member]);
      const pid = (await admin.query("SELECT pg_backend_pid() AS id")).rows[0].id;
      const banning = withRequestContext(admin, { isAdmin: true }, () =>
        admin.query("UPDATE player SET status='banned' WHERE id=$1", [f.ids.playerA]),
      );
      await blocked(f.db.owner, pid);
      await evaluator.query("COMMIT");
      await banning;
      expect((await f.owned()).rows).toHaveLength(1);
      expect(
        (await f.db.owner.query("SELECT status FROM player WHERE id=$1", [f.ids.playerA])).rows[0]
          .status,
      ).toBe("banned");
    } finally {
      await evaluator.query("ROLLBACK");
      evaluator.release();
      admin.release();
    }
  });
  it.each(["enrollment", "player_xp"])(
    "holds player SHARE while waiting for %s without a ban overtaking",
    async (table) => {
      const blocker = await f.pool.connect();
      const evaluator = await f.pool.connect();
      const admin = await f.pool.connect();
      try {
        await blocker.query("BEGIN");
        // The blocker is a system fixture lock, not a reverse-ordered admin operation.
        await f.db.owner.query("BEGIN");
        await f.db.owner.query(
          table === "enrollment"
            ? "SELECT id FROM enrollment WHERE id=$1 FOR NO KEY UPDATE"
            : "SELECT player_id FROM player_xp WHERE player_id=$1 FOR UPDATE",
          [table === "enrollment" ? f.member : f.ids.playerA],
        );
        const evalPid = (await evaluator.query("SELECT pg_backend_pid() AS id")).rows[0].id;
        const granting = withRequestContext(evaluator, {}, () =>
          evaluator.query("SELECT souvenir_evaluate($1) AS n", [f.member]),
        );
        await blocked(blocker, evalPid);
        const banPid = (await admin.query("SELECT pg_backend_pid() AS id")).rows[0].id;
        const banning = withRequestContext(admin, { isAdmin: true }, () =>
          admin.query("UPDATE player SET status='banned' WHERE id=$1", [f.ids.playerA]),
        );
        await blocked(blocker, banPid);
        await f.db.owner.query("COMMIT");
        expect((await granting).rows[0].n).toBe(1);
        await banning;
        expect((await f.owned()).rows).toHaveLength(1);
      } finally {
        await f.db.owner.query("ROLLBACK");
        await blocker.query("ROLLBACK");
        blocker.release();
        evaluator.release();
        admin.release();
      }
    },
  );
  it("keeps a newer source generation due when an older claim acknowledges", async () => {
    await f.run({}, "SELECT souvenir_scan_batch($1)", [f.ids.eventA]);
    const first = (await f.run({}, "SELECT * FROM souvenir_claim_work($1,1)", [f.ids.eventA]))
      .rows[0];
    await f.grant();
    await f.db.owner.query("UPDATE enrollment SET waitlisted=waitlisted WHERE id=$1", [f.member]);
    await f.run({}, "SELECT souvenir_ack($1,$2,$3,NULL)", [
      f.member,
      first.generation,
      first.lease_token,
    ]);
    const next = (await f.run({}, "SELECT * FROM souvenir_claim_work($1,1)", [f.ids.eventA]))
      .rows[0];
    expect(Number(next.generation)).toBeGreaterThan(Number(first.generation));
    expect((await f.grant()).rows[0].n).toBe(0);
    await f.run({}, "SELECT souvenir_ack($1,$2,$3,NULL)", [
      f.member,
      next.generation,
      next.lease_token,
    ]);
    expect((await f.db.owner.query("SELECT * FROM souvenir_work")).rows).toEqual([]);
  });
  it("concurrent evaluators grant once, and expired-lease replay after commit stays idempotent", async () => {
    const grants = await Promise.all([f.grant(), f.grant()]);
    expect(grants.reduce((n, r) => n + Number(r.rows[0].n), 0)).toBe(1);
    await f.run({}, "SELECT souvenir_scan_batch($1)", [f.ids.eventA]);
    const first = (await f.run({}, "SELECT * FROM souvenir_claim_work($1,1)", [f.ids.eventA]))
      .rows[0];
    await f.db.owner.query("UPDATE souvenir_work SET lease_until=now()-interval '1 second'");
    const next = (await f.run({}, "SELECT * FROM souvenir_claim_work($1,1)", [f.ids.eventA]))
      .rows[0];
    expect(next.lease_token).not.toBe(first.lease_token);
    await f.run({}, "SELECT souvenir_ack($1,$2,$3,NULL)", [
      f.member,
      first.generation,
      first.lease_token,
    ]);
    expect((await f.db.owner.query("SELECT * FROM souvenir_work")).rows).toHaveLength(1);
    expect((await f.grant()).rows[0].n).toBe(0);
  });
  it("erasure after a grant removes it and never a following evaluation resurrects it", async () => {
    const token = await f.deletion();
    const evaluator = await f.pool.connect();
    try {
      await evaluator.query("BEGIN");
      await evaluator.query("SELECT souvenir_evaluate($1)", [f.member]);
      const deleting = f.run({}, "SELECT * FROM erase_player($1,true,$2)", [token, randomUUID()]);
      await evaluator.query("COMMIT");
      await deleting;
      expect((await f.owned()).rows).toEqual([]);
      expect((await f.grant()).rows[0].n).toBe(0);
    } finally {
      await evaluator.query("ROLLBACK");
      evaluator.release();
    }
  });
});
