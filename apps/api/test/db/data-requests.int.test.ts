import { createHash, randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withRequestContext, type RequestContext } from "#src/db/context";
import { sqlstate } from "#test/support/push";
import { seedFullPlayer } from "#test/support/full-player";
import { TEST_DATABASE_URL, createTestDatabase, type TestDatabase } from "#test/support/test-db";

type Row = Record<string, unknown>;
type Erased = { outcome: string; events: string[] };

const sha = (value: string): Buffer => createHash("sha256").update(value).digest();
const CASE = "LEGAL-2026/14";

/**
 * Legal data requests in the database (T-708, migration 0129, ADR-480 to ADR-485): the player's own export and its
 * 3-a-day limit, the admin export and erase with their reason and case reference, the shared erase body with a
 * self-deletion (both orders, never a deadlock), the final tombstone and the re-apply after a restore.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("data requests (database)", () => {
  let db: TestDatabase;
  let adminId = "";
  let admin: RequestContext = {};
  let counter = 0;

  const owner = async <T extends Row>(sql: string, values: unknown[] = []) =>
    (await db.owner.query<T>(sql, values)).rows;
  const as = async <T extends Row>(context: RequestContext, sql: string, values: unknown[] = [], client = db.app) =>
    withRequestContext(client, context, async () => (await client.query<T>(sql, values)).rows);
  const one = async <T>(context: RequestContext, sql: string, values: unknown[] = []): Promise<T> =>
    (await as<{ r: T }>(context, sql, values))[0]?.r as T;

  const newPlayer = async (status = "active"): Promise<{ id: string; name: string }> => {
    counter += 1;
    const name = `req_${counter}`;
    const [made] = await owner<{ id: string }>(
      "INSERT INTO player (username, birth_year, status) VALUES ($1, 1990, $2) RETURNING id",
      [name, status],
    );
    const id = made?.id ?? "";
    await owner("INSERT INTO player_contact (player_id, email) VALUES ($1, $2)", [id, `req${counter}@example.com`]);
    return { id, name };
  };
  const ownExport = (player: string) => one<Row>({ playerId: player }, "SELECT own_data_export($1) AS r", [randomUUID()]);
  const adminExport = (target: string, reason = "legal_request", reference = CASE, context = admin) =>
    one<Row>(context, "SELECT console_player_export($1, $2, $3, $4) AS r", [target, reason, reference, randomUUID()]);
  const adminErase = async (target: string, typed: string, forfeit = false, context = admin, client = db.app) =>
    (
      await as<Erased>(
        context,
        "SELECT * FROM admin_erase_player($1, 'player_request', $2, $3, $4, $5)",
        [target, CASE, typed, forfeit, randomUUID()],
        client,
      )
    )[0];
  const audits = (target: string, action: string) =>
    owner<{ actor_type: string; actor_id: string | null; after: Row }>(
      "SELECT actor_type, actor_id, after FROM audit_log WHERE target_id = $1 AND action = $2 ORDER BY id",
      [target, action],
    );

  beforeAll(async () => {
    db = await createTestDatabase();
    const [row] = await owner<{ id: string }>(
      "INSERT INTO staff_user (email, password_hash, platform_role) VALUES ('legal@questify.test', 'h', 'admin') RETURNING id",
    );
    adminId = row?.id ?? "";
    admin = { isAdmin: true, staffUserId: adminId };
  });
  afterAll(async () => {
    await db.close();
  });

  describe("the player's own export", () => {
    it("holds the player's data and nothing of the other player in a shared event", async () => {
      const full = await seedFullPlayer(db.owner);
      const mine = JSON.stringify(await ownExport(full.player));
      expect(mine).toContain(full.phone);
      expect(mine).toContain(full.email);
      expect(mine).toContain(full.username);
      expect(mine).not.toContain(full.other);
      const theirs = JSON.stringify(await ownExport(full.other));
      expect(theirs).not.toContain(full.username);
      expect(theirs).not.toContain(full.phone);
      expect(theirs).not.toContain(full.player);
    });

    it("writes one audit entry and one notice, and keeps admin exports out of the file and the count", async () => {
      const p = await newPlayer();
      await adminExport(p.id);
      const file = await ownExport(p.id);
      expect(file["history"]).toEqual([]);
      expect(JSON.stringify(file)).not.toContain(adminId);
      expect((await audits(p.id, "player.data_export")).map((a) => a.after["source"])).toEqual(["admin", "player"]);
      const notices = await owner("SELECT 1 FROM notice WHERE kind = 'data_exported' AND player_id = $1", [p.id]);
      expect(notices).toHaveLength(1);
      const second = await ownExport(p.id);
      expect(second["history"]).toEqual([expect.objectContaining({ action: "player.data_export" })]);
      await ownExport(p.id);
      const refused = await ownExport(p.id).catch((error: { code: string; message: string }) => error);
      expect(refused).toMatchObject({ code: "DR429" });
      const seconds = Number((refused as { message: string }).message);
      expect(seconds).toBeGreaterThan(86_000);
      expect(seconds).toBeLessThanOrEqual(86_400);
      expect(await audits(p.id, "player.data_export")).toHaveLength(4);
      expect(await owner("SELECT 1 FROM notice WHERE kind = 'data_exported' AND player_id = $1", [p.id])).toHaveLength(3);
    });

    it("counts only the last 24 hours", async () => {
      const p = await newPlayer();
      await owner(
        `INSERT INTO audit_log (at, actor_type, action, target_type, target_id, after)
         SELECT now() - interval '25 hours', 'system', 'player.data_export', 'player', $1, '{"source": "player"}'
         FROM generate_series(1, 3)`,
        [p.id],
      );
      expect(await ownExport(p.id)).toMatchObject({ format: "questify-data-export", version: 1 });
    });

    it("refuses a banned player, a tombstone and no session", async () => {
      const banned = await newPlayer("banned");
      expect(await sqlstate(ownExport(banned.id))).toBe("DR404");
      const gone = await newPlayer();
      await adminErase(gone.id, gone.name);
      expect(await sqlstate(ownExport(gone.id))).toBe("DR404");
      expect(await sqlstate(one({}, "SELECT own_data_export($1) AS r", [randomUUID()]))).toBe("DR404");
      expect(await sqlstate(one({ playerId: banned.id }, "SELECT player_data_export($1) AS r", [banned.id]))).toBe("42501");
    });
  });

  describe("the admin export", () => {
    it("is for an admin, with a known reason and an opaque case reference", async () => {
      const p = await newPlayer();
      const member = { staffUserId: adminId };
      expect(await sqlstate(adminExport(p.id, "legal_request", CASE, member))).toBe("QE403");
      expect(await sqlstate(adminExport(p.id, "curious"))).toBe("DR400");
      for (const bad of ["a@b.sa", "CASE 1", "x".repeat(65), "12345", "966551234567", "1234567890", "ID1234567890", "ab"]) {
        expect(await sqlstate(adminExport(p.id, "legal_request", bad)), bad).toBe("DR400");
      }
      expect(await adminExport(p.id, "legal_request", "CR-2026.7")).toMatchObject({ playerId: p.id });
      const [entry] = await audits(p.id, "player.data_export");
      expect(entry).toMatchObject({
        actor_type: "admin",
        actor_id: adminId,
        after: { source: "admin", reasonCode: "legal_request", reference: "CR-2026.7" },
      });
      expect(await owner("SELECT 1 FROM notice WHERE player_id = $1", [p.id])).toHaveLength(0);
    });

    it("finds nothing on a tombstone or an unknown id", async () => {
      const p = await newPlayer();
      await adminErase(p.id, p.name);
      expect(await sqlstate(adminExport(p.id))).toBe("PA404");
      expect(await sqlstate(adminExport(randomUUID()))).toBe("PA404");
    });
  });

  describe("the admin erase", () => {
    const reserve = async (player: string) => {
      const [org] = await owner<{ id: string }>(
        "INSERT INTO organizer (name, slug) VALUES ('Erase Org', $1) RETURNING id",
        [`erase-${randomUUID().slice(0, 8)}`],
      );
      const [ev] = await owner<{ id: string }>(
        `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at)
         VALUES ($1, $2, 'Erase Fest', 'live', now() - interval '1 hour', now() + interval '1 day') RETURNING id`,
        [org?.id, `ER${String(Date.now()).slice(-8)}`],
      );
      const [n] = await owner<{ id: string }>(
        "INSERT INTO enrollment (organizer_id, event_id, player_id) VALUES ($1, $2, $3) RETURNING id",
        [org?.id, ev?.id, player],
      );
      const [rw] = await owner<{ id: string }>(
        "INSERT INTO reward (event_id, kind, name_en, price, stock_total, units_out) VALUES ($1, 'experience', 'Spa', 5, 9, 1) RETURNING id",
        [ev?.id],
      );
      const [red] = await owner<{ id: string }>(
        `INSERT INTO redemption (organizer_id, event_id, enrollment_id, reward_id, price, idempotency_key, reserved_until)
         VALUES ($1, $2, $3, $4, 5, $5, now() + interval '1 day') RETURNING id`,
        [org?.id, ev?.id, n?.id, rw?.id, randomUUID()],
      );
      await owner(
        `INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta, redemption_id, actor,
                                   staff_user_id)
         VALUES ($1, $2, $3, 'award', 10, 10, NULL, 'staff', $5), ($1, $2, $3, 'redeem', 0, -5, $4, 'player', NULL)`,
        [org?.id, ev?.id, n?.id, red?.id, adminId],
      );
      return { event: ev?.id ?? "", reward: rw?.id ?? "", redemption: red?.id ?? "" };
    };

    it("needs the username typed exactly and the forfeit of pending handovers", async () => {
      const p = await newPlayer();
      const held = await reserve(p.id);
      expect(await sqlstate(adminErase(p.id, p.name.toUpperCase()))).toBe("DR409");
      expect(await sqlstate(adminErase(p.id, ""))).toBe("DR409");
      expect(await adminErase(p.id, p.name)).toEqual({ outcome: "handover_pending", events: [] });
      expect(await owner("SELECT 1 FROM player WHERE id = $1 AND status = 'active'", [p.id])).toHaveLength(1);
      expect(await adminErase(p.id, p.name, true)).toEqual({ outcome: "erased", events: [held.event] });
      expect(await owner("SELECT status, ended_by FROM redemption WHERE id = $1", [held.redemption])).toEqual([
        { status: "cancelled", ended_by: "erasure" },
      ]);
      expect(await owner("SELECT units_out FROM reward WHERE id = $1", [held.reward])).toEqual([{ units_out: 0 }]);
      expect(await adminErase(p.id, p.name, true)).toEqual({ outcome: "already_deleted", events: [] });
      const entries = await audits(p.id, "player.delete");
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        actor_type: "admin",
        actor_id: adminId,
        after: { source: "admin", reasonCode: "player_request", reference: CASE, forfeited: 1 },
      });
    });

    it("refuses a member, a bad reference and an unknown id", async () => {
      const p = await newPlayer();
      expect(await sqlstate(adminErase(p.id, p.name, false, { staffUserId: adminId }))).toBe("QE403");
      expect(
        await sqlstate(
          as(admin, "SELECT * FROM admin_erase_player($1, 'legal_request', '966551234567', $2, false, $3)", [
            p.id,
            p.name,
            randomUUID(),
          ]),
        ),
      ).toBe("DR400");
      expect(await sqlstate(adminErase(randomUUID(), "nobody"))).toBe("PA404");
    });
  });

  describe("an admin erase and a self-erase of one account at once", () => {
    const connect = async () => {
      const client = new Client({ connectionString: db.appUrl });
      await client.connect();
      return client;
    };
    const waitUntilBlocked = async (client: Client) => {
      const pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
      return async () => {
        for (let tries = 0; tries < 300; tries += 1) {
          const rows = await owner("SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND wait_event_type = 'Lock'", [pid]);
          if (rows.length > 0) return;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        throw new Error("the second erase never waited");
      };
    };
    /** A verified deletion challenge, as verify_deletion_code leaves it. */
    const verified = async (player: string): Promise<Buffer> => {
      const token = randomUUID();
      await owner(
        `INSERT INTO player_deletion_challenge (id, token_hash, player_id, contact_key, code_hash, expires_at, deletion_hash,
                                                deletion_expires_at)
         VALUES ($1, $2, $3, $4, $5, now() + interval '5 minutes', $6, now() + interval '10 minutes')`,
        [randomUUID(), sha(`t${token}`), player, sha(`k${token}`), sha(`c${token}`), sha(`d${token}`)],
      );
      return sha(`d${token}`);
    };
    const selfErase = (client: Client, hash: Buffer, hold?: Promise<void>) =>
      withRequestContext(client, {}, async () => {
        const { rows } = await client.query<{ outcome: string }>("SELECT outcome FROM erase_player($1, false, $2)", [
          hash,
          randomUUID(),
        ]);
        await hold;
        return rows[0]?.outcome;
      });
    const adminInTx = (client: Client, p: { id: string; name: string }, hold?: Promise<void>) =>
      withRequestContext(client, admin, async () => {
        const { rows } = await client.query<{ outcome: string }>(
          "SELECT outcome FROM admin_erase_player($1, 'player_request', $2, $3, false, $4)",
          [p.id, CASE, p.name, randomUUID()],
        );
        await hold;
        return rows[0]?.outcome;
      });

    it("self-erase first: the admin then finds a tombstone", async () => {
      const p = await newPlayer();
      const hash = await verified(p.id);
      const [first, second] = [await connect(), await connect()];
      try {
        let release = () => {};
        const hold = new Promise<void>((resolve) => (release = resolve));
        const self = selfErase(first, hash, hold);
        await new Promise((resolve) => setTimeout(resolve, 200));
        const blocked = await waitUntilBlocked(second);
        const other = adminInTx(second, p);
        await blocked();
        release();
        expect(await self).toBe("erased");
        expect(await other).toBe("already_deleted");
      } finally {
        await Promise.all([first.end(), second.end()]);
      }
      expect(await audits(p.id, "player.delete")).toHaveLength(1);
    });

    it("admin first: the self-erase then finds its challenge gone", async () => {
      const p = await newPlayer();
      const hash = await verified(p.id);
      const [first, second] = [await connect(), await connect()];
      try {
        let release = () => {};
        const hold = new Promise<void>((resolve) => (release = resolve));
        const byAdmin = adminInTx(first, p, hold);
        await new Promise((resolve) => setTimeout(resolve, 200));
        const blocked = await waitUntilBlocked(second);
        const self = selfErase(second, hash);
        await blocked();
        release();
        expect(await byAdmin).toBe("erased");
        expect(await self).toBe("expired");
      } finally {
        await Promise.all([first.end(), second.end()]);
      }
      expect(await audits(p.id, "player.delete")).toHaveLength(1);
    });
  });

  describe("the tombstone is final", () => {
    it("refuses any change and any delete, for the owner and in replica mode", async () => {
      const p = await newPlayer();
      await adminErase(p.id, p.name);
      const changes = [
        "UPDATE player SET status = 'active', username = 'back_again' WHERE id = $1",
        "UPDATE player SET birth_year = 1990 WHERE id = $1",
        "UPDATE player SET avatar = 'owl' WHERE id = $1",
        "UPDATE player SET tokens_valid_after = now() WHERE id = $1",
        "DELETE FROM player WHERE id = $1",
      ];
      for (const change of changes) {
        expect(await sqlstate(owner(change, [p.id])), change).toBe("42501");
      }
      await db.owner.query("BEGIN");
      await db.owner.query("SET LOCAL session_replication_role = replica");
      expect(await sqlstate(db.owner.query("UPDATE player SET status = 'active', username = 'back' WHERE id = $1", [p.id]))).toBe(
        "42501",
      );
      await db.owner.query("ROLLBACK");
      const live = await newPlayer();
      await owner("UPDATE player SET avatar = 'owl' WHERE id = $1", [live.id]);
    });
  });

  describe("re-applying erasures after a restore", () => {
    it("erases an active account, skips a tombstone and an unknown id, and is the owner's alone", async () => {
      const p = await newPlayer();
      expect(await owner("SELECT reapply_erasure($1, $2) AS r", [p.id, randomUUID()])).toEqual([{ r: "erased" }]);
      expect(await owner("SELECT reapply_erasure($1, $2) AS r", [p.id, randomUUID()])).toEqual([{ r: "already_deleted" }]);
      expect(await owner("SELECT reapply_erasure($1, $2) AS r", [randomUUID(), randomUUID()])).toEqual([{ r: "unknown" }]);
      const [entry] = await audits(p.id, "player.delete");
      expect(entry).toMatchObject({ actor_type: "system", after: { source: "reapply" } });
      expect(await sqlstate(as({}, "SELECT reapply_erasure($1, $2)", [p.id, randomUUID()]))).toBe("42501");
    });
  });

  describe("the record", () => {
    it("shows the legal history on an account and on its tombstone, with no restore", async () => {
      const p = await newPlayer();
      await adminExport(p.id);
      const before = await one<Row>(admin, "SELECT console_player_record($1, $2) AS r", [p.id, randomUUID()]);
      expect(before["legalRequests"]).toEqual([
        expect.objectContaining({ action: "player.data_export", source: "admin", reference: CASE, by: "legal@questify.test" }),
      ]);
      await adminErase(p.id, p.name);
      const after = await one<Row>(admin, "SELECT console_player_record($1, $2) AS r", [p.id, randomUUID()]);
      expect(after["legalRequests"]).toHaveLength(2);
      expect(after["player"]).toMatchObject({ status: "deleted" });
      expect(await owner("SELECT 1 FROM pg_proc WHERE proname ~ 'restore' AND proname ~ 'player'")).toEqual([]);
    });
  });

  it("builds a heavy player's export within the statement budget (timing recorded, not asserted)", async () => {
    const p = await newPlayer();
    const [org] = await owner<{ id: string }>("INSERT INTO organizer (name, slug) VALUES ('Heavy', 'heavy') RETURNING id");
    await owner(
      `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at)
       SELECT $1, 'HVY' || lpad(g::text, 3, '0'), 'Heavy ' || g, 'live', now() - interval '1 hour', now() + interval '1 day'
       FROM generate_series(1, 50) g`,
      [org?.id],
    );
    await owner(
      `INSERT INTO enrollment (organizer_id, event_id, player_id) SELECT $1, e.id, $2 FROM event e WHERE e.organizer_id = $1`,
      [org?.id, p.id],
    );
    await owner(
      `INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta, actor, staff_user_id)
       SELECT n.organizer_id, n.event_id, n.id, 'award', 1, 1, 'staff', $2
       FROM enrollment n CROSS JOIN generate_series(1, 200) WHERE n.player_id = $1`,
      [p.id, adminId],
    );
    await owner(
      `WITH made AS (
         INSERT INTO notice (kind, player_id, audience, dedupe, expires_at)
         SELECT 'username_changed', $1, 'player', 'heavy' || g, now() + interval '1 day' FROM generate_series(1, 2000) g
         RETURNING id)
       INSERT INTO notification (notice_id, player_id) SELECT id, $1 FROM made`,
      [p.id],
    );
    const started = performance.now();
    const file = await ownExport(p.id);
    const took = Math.round(performance.now() - started);
    console.info(`T-708 heavy export: 50 events, 10000 ledger entries, 2000 notifications in ${took} ms`);
    expect(JSON.stringify(file).length).toBeGreaterThan(1_000_000);
  });
});
