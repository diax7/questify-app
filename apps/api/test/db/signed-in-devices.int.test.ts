import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  TEST_DATABASE_URL,
  connectAsOwner,
  createTestDatabase,
  type TestDatabase,
} from "#test/support/test-db";

const bytes = () => randomBytes(32);
const sha = (value: Buffer) => createHash("sha256").update(value).digest();

type Tokens = { access: Buffer; refresh: Buffer; family: string };
const tokens = (): Tokens => ({ access: bytes(), refresh: bytes(), family: randomUUID() });

const pidOf = async (client: Client) =>
  (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid ?? 0;

type Player = { id: string; phone: string; first: Tokens };

/** Runs `sql` on the held transaction, keeping an error (a deadlock) instead of throwing it. */
const tryOn = async (client: Client, sql: string, values: unknown[] = []) => {
  try {
    return (await client.query(sql, values)).rows;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
};
const codeOf = (outcome: unknown) =>
  outcome instanceof Error ? (outcome as Error & { code?: string }).code : undefined;

/**
 * Signed-in devices in the database (T-810c, migration 0155, plan review 84): one device row per refresh family, the
 * one way a family ends (end_family, device row first), the fresh factor checked here, the player's and the staff
 * member's end doors, the console's end of one staff account, and the races between an end, a rotation and a sign-in.
 * The lock order of 0184 (docs/plans/2026-11-09-sign-in-lock-order.md, tests 8 to 21): the sweep never waits for a
 * device row or a code, and end-others locks its own device row with the others and re-reads it.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("signed-in devices (database)", () => {
  let db: TestDatabase;
  let counter = 0;

  beforeAll(async () => {
    db = await createTestDatabase();
  });
  afterAll(async () => {
    await db.close();
  });

  const owner = async <T extends Record<string, unknown>>(sql: string, values: unknown[] = []) =>
    (await db.owner.query<T>(sql, values)).rows;

  /** Runs one statement in a transaction whose context is the given player (or staff member, admin). */
  const as = async <T extends Record<string, unknown>>(
    who: { player?: string; staff?: string; admin?: boolean },
    sql: string,
    values: unknown[] = [],
    client: Client = db.app,
  ): Promise<T[]> => {
    await client.query("BEGIN");
    try {
      await client.query(
        "SELECT set_config('app.player_id', $1, true), set_config('app.staff_user_id', $2, true), set_config('app.is_admin', $3, true)",
        [who.player ?? "", who.staff ?? "", who.admin === true ? "on" : ""],
      );
      const { rows } = await client.query<T>(sql, values);
      await client.query("COMMIT");
      return rows;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  };

  const challengeFor = async (phone: string) => {
    const made = { token: bytes(), code: bytes() };
    await db.app.query(
      "SELECT start_player_challenge($1, $2, 'phone', $3, $4, $5, '0.1', '0.1', $6)",
      [randomUUID(), made.token, phone, sha(Buffer.from(phone)), made.code, bytes()],
    );
    return made;
  };

  /** A sign-in on a new phone (a new family) for an existing number. */
  const signInAgain = async (
    phone: string,
    client: Client = db.app,
    asked?: Awaited<ReturnType<typeof challengeFor>>,
  ): Promise<Tokens> => {
    const c = asked ?? (await challengeFor(phone));
    const t = tokens();
    const { rows } = await client.query<{ outcome: string }>(
      "SELECT * FROM sign_in_player($1, $2, $3, $4, $5, $6, sha256('not the fixed code'::bytea))",
      [c.token, c.code, sha(t.access), sha(t.refresh), t.family, sha(bytes())],
    );
    expect(rows[0]?.outcome).toBe("signed_in");
    return t;
  };

  const newPlayer = async (): Promise<Player> => {
    counter += 1;
    const phone = `+96656${String(1_000_000 + counter).slice(-7)}`;
    const c = await challengeFor(phone);
    const signup = bytes();
    await db.app.query(
      "SELECT * FROM sign_in_player($1, $2, $3, $4, $5, $6, sha256('not the fixed code'::bytea))",
      [c.token, c.code, sha(bytes()), sha(bytes()), randomUUID(), sha(signup)],
    );
    const first = tokens();
    const { rows } = await db.app.query<{ player_id: string }>(
      "SELECT * FROM create_player($1, $2, 1995, 'falcon', $3, $4, $5)",
      [sha(signup), `device_${counter}`, sha(first.access), sha(first.refresh), first.family],
    );
    return { id: rows[0]?.player_id ?? "", phone, first };
  };

  const rotate = async (presented: Tokens, next: Tokens, client: Client = db.app) => {
    const { rows } = await client.query<{ outcome: string }>(
      "SELECT outcome FROM rotate_player_refresh($1, $2, $3)",
      [sha(presented.refresh), sha(next.access), sha(next.refresh)],
    );
    return rows[0]?.outcome;
  };

  const deviceOf = async (family: string) =>
    (
      await owner<{ id: string; ended: boolean; platform: string | null; model: string | null }>(
        "SELECT id, ended_at IS NOT NULL AS ended, platform, model FROM player_sign_in_device WHERE family = $1",
        [family],
      )
    )[0];

  /** Live refresh and access tokens left in a family. */
  const liveIn = async (family: string) =>
    (
      await owner<{ refresh: number; access: number }>(
        `SELECT (SELECT count(*)::int FROM player_refresh WHERE family = $1 AND revoked_at IS NULL) AS refresh,
                (SELECT count(*)::int FROM player_session WHERE refresh_family = $1 AND revoked_at IS NULL) AS access`,
        [family],
      )
    )[0];

  /** Moves a family's sign-in (and any re-authentication) `seconds` into the past. */
  const age = (family: string, seconds: number) =>
    owner(
      `UPDATE player_sign_in_device SET signed_in_at = signed_in_at - make_interval(secs => $2),
                                        reauth_at = reauth_at - make_interval(secs => $2)
       WHERE family = $1`,
      [family, seconds],
    );

  const endDevice = (player: Player, session: Tokens, target: string, client: Client = db.app) =>
    as<{ outcome: string }>(
      { player: player.id },
      "SELECT end_player_device($1, $2, $3) AS outcome",
      [sha(session.access), target, randomUUID()],
      client,
    ).then((rows) => rows[0]?.outcome);

  const endOthers = (player: Player, session: Tokens, client: Client = db.app) =>
    as<{ outcome: string; ended: number }>(
      { player: player.id },
      "SELECT * FROM end_other_player_devices($1, $2)",
      [sha(session.access), randomUUID()],
      client,
    ).then((rows) => rows[0]);

  const list = (player: Player, session: Tokens) =>
    as<{ id: string; is_current: boolean; fresh_until: Date | null; model: string | null }>(
      { player: player.id },
      "SELECT * FROM player_devices($1)",
      [sha(session.access)],
    );

  /** Waits until a backend is blocked on a lock (the other side of a race holds it). */
  const waitForLock = async (pid: number) => {
    for (let tries = 0; tries < 200; tries += 1) {
      const rows = await owner<{ waiting: boolean }>(
        "SELECT wait_event_type = 'Lock' AS waiting FROM pg_stat_activity WHERE pid = $1",
        [pid],
      );
      if (rows[0]?.waiting === true) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`backend ${pid} never waited for a lock`);
  };

  describe("one device row per family", () => {
    it("a sign-up, a sign-in and a rotation keep one row per family; the 11th sign-in ends the oldest", async () => {
      const p = await newPlayer();
      const second = await signInAgain(p.phone);
      const next = tokens();
      expect(await rotate(second, next)).toBe("rotated");
      expect(
        await owner<{ n: number }>(
          "SELECT count(*)::int AS n FROM player_sign_in_device WHERE player_id = $1",
          [p.id],
        ),
      ).toEqual([{ n: 2 }]);
      const fams = [p.first.family, second.family];
      for (let k = 0; k < 9; k += 1) {
        fams.push((await signInAgain(p.phone)).family);
      }
      expect(await deviceOf(p.first.family)).toMatchObject({ ended: true });
      expect(await liveIn(p.first.family)).toEqual({ refresh: 0, access: 0 });
      expect(await deviceOf(second.family)).toMatchObject({ ended: false });
    });

    it("answers invalid for a rotation of an ended family or a family with no device row", async () => {
      const p = await newPlayer();
      await owner("UPDATE player_sign_in_device SET ended_at = now() WHERE family = $1", [
        p.first.family,
      ]);
      expect(await rotate(p.first, tokens())).toBe("invalid");
      const other = await newPlayer();
      await owner("DELETE FROM player_sign_in_device WHERE family = $1", [other.first.family]);
      expect(await rotate(other.first, tokens())).toBe("invalid");
    });
  });

  const label = (refresh: Buffer, model: string | null) =>
    db.app
      .query<{ ok: boolean }>("SELECT label_player_device($1, 'ios', $2) AS ok", [
        sha(refresh),
        model,
      ])
      .then((r) => r.rows[0]?.ok);

  describe("the label", () => {
    it("labels a family once, by its live refresh token only", async () => {
      const p = await newPlayer();
      expect(await label(bytes(), "iPhone 15")).toBe(false);
      expect(await label(p.first.refresh, "iPhone 15 Pro")).toBe(true);
      expect(await label(p.first.refresh, "Pixel 8")).toBe(false);
      expect(await deviceOf(p.first.family)).toMatchObject({
        platform: "ios",
        model: "iPhone 15 Pro",
      });
      const next = tokens();
      await rotate(p.first, next);
      const spent = await newPlayer();
      await owner("UPDATE player_refresh SET used_at = now() WHERE family = $1", [
        spent.first.family,
      ]);
      expect(await label(spent.first.refresh, "Pixel 8")).toBe(false);
      const fresh = await newPlayer();
      await expect(label(fresh.first.refresh, "<script>")).rejects.toThrow(/check constraint/);
    });
  });

  describe("the list", () => {
    it("lists the caller's live devices, this one first with its fresh end, and none of another player's", async () => {
      const p = await newPlayer();
      const other = await signInAgain(p.phone);
      const stranger = await newPlayer();
      const rows = await list(p, other);
      expect(rows.map((r) => r.is_current)).toEqual([true, false]);
      expect(rows[0]?.id).toBe((await deviceOf(other.family))?.id);
      expect(rows[0]?.fresh_until).not.toBeNull();
      expect(rows[1]?.fresh_until).toBeNull();
      expect(rows.map((r) => r.id)).not.toContain((await deviceOf(stranger.first.family))?.id);
      await owner(
        "UPDATE player_refresh SET expires_at = now() - interval '1 second' WHERE family = $1",
        [p.first.family],
      );
      expect((await list(p, other)).map((r) => r.is_current)).toEqual([true]);
    });

    it("refuses a session that is not the caller's (PN401)", async () => {
      const p = await newPlayer();
      const stranger = await newPlayer();
      await expect(list(p, stranger.first)).rejects.toMatchObject({ code: "PN401" });
    });
  });

  describe("ending devices", () => {
    it("ends another device when fresh, and answers every refusal", async () => {
      const p = await newPlayer();
      const phone = await signInAgain(p.phone);
      const target = (await deviceOf(p.first.family))?.id ?? "";
      await age(phone.family, 601);
      expect(await endDevice(p, phone, target)).toBe("reauth_required");
      await age(phone.family, -10);
      expect(await endDevice(p, phone, (await deviceOf(phone.family))?.id ?? "")).toBe("current");
      expect(await endDevice(p, phone, randomUUID())).toBe("not_found");
      expect(await endDevice(p, phone, target)).toBe("ended");
      expect(await liveIn(p.first.family)).toEqual({ refresh: 0, access: 0 });
      expect(await rotate(p.first, tokens())).toBe("invalid");
      expect(await endDevice(p, phone, target)).toBe("already_ended");
      expect(await liveIn(phone.family)).toEqual({ refresh: 1, access: 1 });
      expect(
        await owner<{ n: number }>(
          "SELECT count(*)::int AS n FROM audit_log WHERE action = 'player.device.end' AND target_id = $1",
          [p.id],
        ),
      ).toEqual([{ n: 1 }]);
    });

    it("answers not_found for another player's device, which stays live", async () => {
      const a = await newPlayer();
      const b = await newPlayer();
      const bDevice = (await deviceOf(b.first.family))?.id ?? "";
      expect(await endDevice(a, a.first, bDevice)).toBe("not_found");
      expect(await liveIn(b.first.family)).toEqual({ refresh: 1, access: 1 });
    });

    it("ends every other device, then none, and keeps this one", async () => {
      const p = await newPlayer();
      const others = [await signInAgain(p.phone), await signInAgain(p.phone)];
      const here = await signInAgain(p.phone);
      expect(await endOthers(p, here)).toEqual({ outcome: "ended", ended: 3 });
      for (const t of [p.first, ...others]) {
        expect(await liveIn(t.family)).toEqual({ refresh: 0, access: 0 });
      }
      expect(await liveIn(here.family)).toEqual({ refresh: 1, access: 1 });
      expect(await endOthers(p, here)).toEqual({ outcome: "ended", ended: 0 });
      await age(here.family, 601);
      expect(await endOthers(p, here)).toEqual({ outcome: "reauth_required", ended: 0 });
    });

    it("removes the ended family's push device and its queued sends, not this phone's", async () => {
      const p = await newPlayer();
      const here = await signInAgain(p.phone);
      for (const [family, token] of [
        [p.first.family, "a".repeat(64)],
        [here.family, "b".repeat(64)],
      ] as const) {
        await owner(
          `INSERT INTO push_device (player_id, family, platform, token, environment, language, app_version)
           VALUES ($1, $2, 'ios', $3, 'production', 'ar', '1')`,
          [p.id, family, token],
        );
      }
      expect(await endOthers(p, here)).toMatchObject({ ended: 1 });
      expect(
        await owner<{ family: string }>("SELECT family FROM push_device WHERE player_id = $1", [
          p.id,
        ]),
      ).toEqual([{ family: here.family }]);
    });

    it("the sweep removes device rows a week after they end", async () => {
      const p = await newPlayer();
      const here = await signInAgain(p.phone);
      await endOthers(p, here);
      await owner(
        "UPDATE player_sign_in_device SET ended_at = now() - interval '8 days' WHERE family = $1",
        [p.first.family],
      );
      await db.app.query("SELECT sweep_player_sign_in()");
      expect(await deviceOf(p.first.family)).toBeUndefined();
      expect(await deviceOf(here.family)).toMatchObject({ ended: false });
    });
  });

  const start = (p: Player, session: Tokens, method: string, token: Buffer, code: Buffer) =>
    as<{ outcome: string; contact: string | null; masked: string | null }>(
      { player: p.id },
      "SELECT * FROM start_player_reauth($1, $2, $3, $4)",
      [sha(session.access), method, token, code],
    ).then((rows) => rows[0]);
  const confirm = (p: Player, session: Tokens, token: Buffer, code: Buffer) =>
    as<{ outcome: string; attempts_left: number; fresh_until: Date | null }>(
      { player: p.id },
      "SELECT * FROM confirm_player_reauth($1, $2, $3, $4)",
      [sha(session.access), token, code, randomUUID()],
    ).then((rows) => rows[0]);

  describe("a fresh factor", () => {
    it("a code typed on this family makes it fresh; three wrong tries end the code", async () => {
      const p = await newPlayer();
      const here = await signInAgain(p.phone);
      await age(here.family, 601);
      expect(await start(p, here, "email", bytes(), bytes())).toMatchObject({
        outcome: "no_contact",
      });
      const token = bytes();
      const code = bytes();
      const started = await start(p, here, "phone", token, code);
      expect(started).toMatchObject({ outcome: "started", contact: p.phone });
      expect(started?.masked).toMatch(/^\+9665•••••\d\d$/);
      expect(await confirm(p, here, token, bytes())).toMatchObject({
        outcome: "wrong",
        attempts_left: 2,
      });
      expect(await confirm(p, here, token, code)).toMatchObject({ outcome: "confirmed" });
      expect(await endOthers(p, here)).toMatchObject({ outcome: "ended", ended: 1 });
      expect(await confirm(p, here, token, code)).toMatchObject({ outcome: "expired" });
      const again = bytes();
      await start(p, here, "phone", again, code);
      for (let k = 0; k < 3; k += 1) await confirm(p, here, again, bytes());
      expect(await confirm(p, here, again, code)).toMatchObject({ outcome: "expired" });
    });

    it("a code asked on one family proves nothing on another", async () => {
      const p = await newPlayer();
      const laptop = await signInAgain(p.phone);
      await age(p.first.family, 601);
      await age(laptop.family, 601);
      const token = bytes();
      const code = bytes();
      await start(p, laptop, "phone", token, code);
      expect(await confirm(p, p.first, token, code)).toMatchObject({ outcome: "expired" });
      expect(await confirm(p, laptop, token, code)).toMatchObject({ outcome: "confirmed" });
      expect(await endOthers(p, p.first)).toMatchObject({ outcome: "reauth_required" });
    });

    it("a contact change on this family makes it fresh", async () => {
      const p = await newPlayer();
      await age(p.first.family, 601);
      const token = bytes();
      const code = bytes();
      await as({ player: p.id }, "SELECT start_contact_change($1, $2, 'email', $3, $4, $5)", [
        randomUUID(),
        token,
        `fresh${counter}@example.com`,
        code,
        bytes(),
      ]);
      const changed = await as<{ outcome: string }>(
        { player: p.id },
        "SELECT outcome FROM confirm_contact_change($1, $2, $3, $4)",
        [sha(p.first.access), token, code, randomUUID()],
      );
      expect(changed[0]?.outcome).toBe("changed");
      expect((await list(p, p.first))[0]?.fresh_until).not.toBeNull();
    });
  });

  /** Starts `sql` on `client` and reports whether it blocked on a lock before it settled (the caller releases it). */
  const startAlone = async (client: Client, sql: string, values: unknown[] = []) => {
    const pid = await pidOf(client);
    const state = { settled: false };
    const run = client.query(sql, values).then(
      (result) => {
        state.settled = true;
        return result.rows;
      },
      (error: unknown) => {
        state.settled = true;
        return error instanceof Error ? error : new Error(String(error));
      },
    );
    for (let tries = 0; tries < 200 && !state.settled; tries += 1) {
      const rows = await owner<{ waiting: boolean }>(
        "SELECT wait_event_type = 'Lock' AS waiting FROM pg_stat_activity WHERE pid = $1",
        [pid],
      );
      if (rows[0]?.waiting === true) return { waited: true, run };
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return { waited: false, run };
  };
  const sweepAlone = () => startAlone(db.app, "SELECT sweep_player_sign_in()");
  /** Moves every refresh and access row of a family, and its device's sign-in, `days` into the past. */
  const idle = (family: string, days: number) =>
    owner(
      `WITH r AS (UPDATE player_refresh SET created_at = created_at - make_interval(days => $2),
                                             expires_at = now() - make_interval(days => $2),
                                             used_at = used_at - make_interval(days => $2),
                                             revoked_at = revoked_at - make_interval(days => $2)
                  WHERE family = $1 RETURNING 1)
       UPDATE player_session SET expires_at = now() - make_interval(days => $2),
                                 revoked_at = revoked_at - make_interval(days => $2)
       WHERE refresh_family = $1`,
      [family, days],
    );
  const rowsOf = async (family: string) =>
    (
      await owner<{ refresh: number; access: number; device: number }>(
        `SELECT (SELECT count(*)::int FROM player_refresh WHERE family = $1) AS refresh,
                (SELECT count(*)::int FROM player_session WHERE refresh_family = $1) AS access,
                (SELECT count(*)::int FROM player_sign_in_device WHERE family = $1) AS device`,
        [family],
      )
    )[0];

  /** Holds `sql` for `player` on db.app (its own transaction, left open). */
  const hold = async (player: Player, sql: string, values: unknown[]) => {
    await db.app.query("BEGIN");
    await db.app.query("SELECT set_config('app.player_id', $1, true)", [player.id]);
    return (await db.app.query(sql, values)).rows;
  };

  describe("races (ADR-712)", () => {
    let other: Client;
    beforeAll(async () => {
      other = await connectAsOwner(db);
    });
    afterAll(async () => {
      await other.end();
    });

    it("an end and a rotation of one family, both orders, leave no live token", async () => {
      for (const endFirst of [true, false]) {
        const p = await newPlayer();
        const here = await signInAgain(p.phone);
        const target = (await deviceOf(p.first.family))?.id ?? "";
        const holder = endFirst ? db.app : other;
        await holder.query("BEGIN");
        if (endFirst) {
          await holder.query("SELECT set_config('app.player_id', $1, true)", [p.id]);
          await holder.query("SELECT end_player_device($1, $2, $3)", [
            sha(here.access),
            target,
            randomUUID(),
          ]);
        } else {
          expect(await rotate(p.first, tokens(), holder)).toBe("rotated");
        }
        const waiter = endFirst ? other : db.app;
        const pid = await pidOf(waiter);
        const pending = endFirst
          ? rotate(p.first, tokens(), waiter)
          : endDevice(p, here, target, waiter);
        await waitForLock(pid);
        await holder.query("COMMIT");
        expect(await pending).toBe(endFirst ? "invalid" : "ended");
        expect(await liveIn(p.first.family)).toEqual({ refresh: 0, access: 0 });
      }
    });

    it("an 11th sign-in while the oldest family rotates, both orders: no deadlock, no live token left", async () => {
      for (const rotateFirst of [true, false]) {
        const p = await newPlayer();
        for (let k = 0; k < 9; k += 1) await signInAgain(p.phone);
        const holder = rotateFirst ? other : db.app;
        const waiter = rotateFirst ? db.app : other;
        const asked = await challengeFor(p.phone);
        await holder.query("BEGIN");
        let pending: Promise<unknown>;
        if (rotateFirst) {
          expect(await rotate(p.first, tokens(), holder)).toBe("rotated");
          const pid = await pidOf(waiter);
          pending = signInAgain(p.phone, waiter, asked);
          await waitForLock(pid);
        } else {
          await signInAgain(p.phone, holder, asked);
          const pid = await pidOf(waiter);
          pending = rotate(p.first, tokens(), waiter);
          await waitForLock(pid);
        }
        await holder.query("COMMIT");
        const result = await pending;
        if (!rotateFirst) expect(result).toBe("invalid");
        expect(await liveIn(p.first.family)).toEqual({ refresh: 0, access: 0 });
        expect(await deviceOf(p.first.family)).toMatchObject({ ended: true });
      }
    });

    it("end-others ends exactly the families it locked; a sign-in that commits afterwards stays live", async () => {
      const p = await newPlayer();
      const here = await signInAgain(p.phone);
      const asked = await challengeFor(p.phone);
      await db.app.query("BEGIN");
      await db.app.query("SELECT set_config('app.player_id', $1, true)", [p.id]);
      const ended = await db.app.query<{ ended: number }>(
        "SELECT ended FROM end_other_player_devices($1, $2)",
        [sha(here.access), randomUUID()],
      );
      const late = await signInAgain(p.phone, other, asked);
      await db.app.query("COMMIT");
      expect(ended.rows[0]?.ended).toBe(1);
      expect(await liveIn(p.first.family)).toEqual({ refresh: 0, access: 0 });
      expect(await liveIn(late.family)).toEqual({ refresh: 1, access: 1 });
      expect(await deviceOf(late.family)).toMatchObject({ ended: false });
    });

    const lockDevice = async (family: string) => {
      await other.query("BEGIN");
      await other.query("SELECT 1 FROM player_sign_in_device WHERE family = $1 FOR UPDATE", [
        family,
      ]);
    };

    it("a sweep never waits for the device row of an idle family a rotation holds (0184, test 8)", async () => {
      const p = await newPlayer();
      await idle(p.first.family, 8);
      await lockDevice(p.first.family);
      const sweep = await sweepAlone();
      const rotated = await tryOn(other, "SELECT outcome FROM rotate_player_refresh($1, $2, $3)", [
        sha(p.first.refresh),
        sha(bytes()),
        sha(bytes()),
      ]);
      await other.query(rotated instanceof Error ? "ROLLBACK" : "COMMIT");
      const swept = await sweep.run;
      expect(sweep.waited).toBe(false);
      expect(rotated).toEqual([{ outcome: "invalid" }]);
      expect(codeOf(swept)).toBeUndefined();
      await db.app.query("SELECT sweep_player_sign_in()");
      expect(await rowsOf(p.first.family)).toEqual({ refresh: 0, access: 0, device: 0 });
    });

    it("a sweep never waits for a sign-out of an idle family (0184, test 9)", async () => {
      const p = await newPlayer();
      await idle(p.first.family, 8);
      await lockDevice(p.first.family);
      const sweep = await sweepAlone();
      const out = await tryOn(other, "SELECT sign_out_player($1)", [sha(p.first.refresh)]);
      await other.query(out instanceof Error ? "ROLLBACK" : "COMMIT");
      const swept = await sweep.run;
      expect(sweep.waited).toBe(false);
      expect(codeOf(out)).toBeUndefined();
      expect(codeOf(swept)).toBeUndefined();
      expect(await deviceOf(p.first.family)).toMatchObject({ ended: true });
    });

    it("a sweep never waits for an erasure holding a device that ended a week ago (0184, test 10)", async () => {
      const p = await newPlayer();
      const here = await signInAgain(p.phone);
      await endOthers(p, here);
      await owner(
        "UPDATE player_sign_in_device SET ended_at = now() - interval '8 days' WHERE family = $1",
        [p.first.family],
      );
      await idle(p.first.family, 8);
      await other.query("BEGIN");
      await other.query(
        "SELECT 1 FROM player_sign_in_device WHERE player_id = $1 ORDER BY id FOR UPDATE",
        [p.id],
      );
      const sweep = await sweepAlone();
      const erased = await tryOn(
        other,
        "WITH s AS (DELETE FROM player_session WHERE player_id = $1) DELETE FROM player_refresh WHERE player_id = $1",
        [p.id],
      );
      await other.query("ROLLBACK");
      const swept = await sweep.run;
      expect(sweep.waited).toBe(false);
      expect(codeOf(erased)).toBeUndefined();
      expect(codeOf(swept)).toBeUndefined();
    });

    it("a replay of a token used a week ago, crossed with the sweep both ways, never deadlocks (0184, test 11)", async () => {
      for (const replayFirst of [true, false]) {
        const p = await newPlayer();
        const next = tokens();
        expect(await rotate(p.first, next)).toBe("rotated");
        await owner(
          `UPDATE player_refresh SET used_at = now() - interval '8 days', created_at = now() - interval '9 days'
           WHERE token_hash = $1`,
          [sha(p.first.refresh)],
        );
        const replay = "SELECT outcome FROM rotate_player_refresh($1, $2, $3)";
        const values = [sha(p.first.refresh), sha(bytes()), sha(bytes())];
        let outcome: unknown;
        let waited: boolean;
        if (replayFirst) {
          await other.query("BEGIN");
          outcome = await tryOn(other, replay, values);
          const sweep = await sweepAlone();
          waited = sweep.waited;
          await other.query(outcome instanceof Error ? "ROLLBACK" : "COMMIT");
          expect(codeOf(await sweep.run)).toBeUndefined();
          expect(waited).toBe(false);
          expect(outcome).toEqual([{ outcome: "reused" }]);
          expect(await liveIn(next.family)).toEqual({ refresh: 0, access: 0 });
          expect(await deviceOf(p.first.family)).toMatchObject({ ended: true });
        } else {
          await db.app.query("BEGIN");
          await db.app.query("SELECT sweep_player_sign_in()");
          const rotation = await startAlone(other, replay, values);
          waited = rotation.waited;
          await db.app.query("COMMIT");
          outcome = await rotation.run;
          // The sweep held the family's device row; the replayed row is gone once it commits.
          expect(waited).toBe(true);
          expect(outcome).toEqual([{ outcome: "invalid" }]);
        }
      }
      expect(
        (await owner("SELECT 1 FROM audit_log WHERE action = 'player.refresh_reuse'")).length,
      ).toBeGreaterThan(0);
    });

    it("a family the sweep skipped keeps its old rows until the next run (0184, test 12)", async () => {
      const p = await newPlayer();
      const next = tokens();
      expect(await rotate(p.first, next)).toBe("rotated");
      await owner(
        "UPDATE player_refresh SET used_at = now() - interval '8 days' WHERE token_hash = $1",
        [sha(p.first.refresh)],
      );
      await lockDevice(p.first.family);
      const sweep = await sweepAlone();
      if (!sweep.waited) await sweep.run;
      const kept = (await rowsOf(p.first.family))?.refresh;
      await other.query("COMMIT");
      await sweep.run;
      expect(sweep.waited).toBe(false);
      expect(kept).toBe(2);
      await db.app.query("SELECT sweep_player_sign_in()");
      expect((await rowsOf(p.first.family))?.refresh).toBe(1);
      expect(await liveIn(p.first.family)).toEqual({ refresh: 1, access: 1 });
    });

    /** End-others on the other connection, as the player (a session setting: one statement, no transaction). */
    const endOthersAlone = async (player: Player, session: Tokens) => {
      await other.query("SELECT set_config('app.player_id', $1, false)", [player.id]);
      return startAlone(other, "SELECT * FROM end_other_player_devices($1, $2)", [
        sha(session.access),
        randomUUID(),
      ]);
    };

    it("end-others from two devices at once: the second waits and is refused (0184, test 13)", async () => {
      const p = await newPlayer();
      const b = await signInAgain(p.phone);
      await hold(p, "SELECT * FROM end_other_player_devices($1, $2)", [
        sha(p.first.access),
        randomUUID(),
      ]);
      const second = await endOthersAlone(p, b);
      await db.app.query("COMMIT");
      const answer = await second.run;
      expect(second.waited).toBe(true);
      expect(codeOf(answer)).toBe("PN401");
      expect(await liveIn(p.first.family)).toEqual({ refresh: 1, access: 1 });
      expect(await liveIn(b.family)).toEqual({ refresh: 0, access: 0 });
    });

    it("end-others from a device another device is ending waits and is refused (0184, test 14)", async () => {
      const p = await newPlayer();
      const b = await signInAgain(p.phone);
      const a = (await deviceOf(p.first.family))?.id ?? "";
      await hold(p, "SELECT end_player_device($1, $2, $3)", [sha(b.access), a, randomUUID()]);
      const fromA = await endOthersAlone(p, p.first);
      await db.app.query("COMMIT");
      const answer = await fromA.run;
      expect(fromA.waited).toBe(true);
      expect(codeOf(answer)).toBe("PN401");
      expect(await liveIn(b.family)).toEqual({ refresh: 1, access: 1 });
    });

    it("end-others reads the fresh check under the lock: a code confirmed meanwhile counts (0184, test 15)", async () => {
      const p = await newPlayer();
      const here = await signInAgain(p.phone);
      await age(here.family, 601);
      const token = bytes();
      const code = bytes();
      await start(p, here, "phone", token, code);
      const confirmed = await hold(p, "SELECT outcome FROM confirm_player_reauth($1, $2, $3, $4)", [
        sha(here.access),
        token,
        code,
        randomUUID(),
      ]);
      expect(confirmed).toEqual([{ outcome: "confirmed" }]);
      const ending = await endOthersAlone(p, here);
      await db.app.query("COMMIT");
      const answer = await ending.run;
      expect(ending.waited).toBe(true);
      expect(answer).toMatchObject([{ outcome: "ended", ended: 1 }]);
    });

    it("end-others waits for a rotation of its own family, then ends the others (0184, test 16)", async () => {
      const p = await newPlayer();
      const here = await signInAgain(p.phone);
      await db.app.query("BEGIN");
      expect(await rotate(here, tokens(), db.app)).toBe("rotated");
      const ending = await endOthersAlone(p, here);
      await db.app.query("COMMIT");
      const answer = await ending.run;
      expect(ending.waited).toBe(true);
      expect(answer).toMatchObject([{ outcome: "ended", ended: 1 }]);
      expect(await liveIn(p.first.family)).toEqual({ refresh: 0, access: 0 });
    });

    it("end-others ends only the rows it locked: a sign-in that commits while it waits stays live (0184, test 17b)", async () => {
      const p = await newPlayer();
      const here = await signInAgain(p.phone);
      const asked = await challengeFor(p.phone);
      const third = await connectAsOwner(db);
      try {
        await db.app.query("BEGIN");
        expect(await rotate(here, tokens(), db.app)).toBe("rotated");
        const ending = await endOthersAlone(p, here);
        const late = await signInAgain(p.phone, third, asked);
        await db.app.query("COMMIT");
        expect(await ending.run).toMatchObject([{ outcome: "ended", ended: 1 }]);
        expect(await liveIn(late.family)).toEqual({ refresh: 1, access: 1 });
      } finally {
        await third.end();
      }
    });

    it("two sweeps at once: the second never waits, and nothing old is left after both (0184, test 18)", async () => {
      const p = await newPlayer();
      const here = await signInAgain(p.phone);
      await endOthers(p, here);
      await owner(
        "UPDATE player_sign_in_device SET ended_at = now() - interval '8 days' WHERE family = $1",
        [p.first.family],
      );
      await idle(p.first.family, 8);
      await other.query("BEGIN");
      await other.query("SELECT sweep_player_sign_in()");
      const second = await sweepAlone();
      await other.query("COMMIT");
      expect(codeOf(await second.run)).toBeUndefined();
      expect(second.waited).toBe(false);
      expect(await rowsOf(p.first.family)).toEqual({ refresh: 0, access: 0, device: 0 });
    });

    it("a sweep skips a code another call holds and removes it at the next run (0184, test 19)", async () => {
      const p = await newPlayer();
      const old = await challengeFor(p.phone);
      await owner(
        "UPDATE player_login_challenge SET expires_at = now() - interval '2 hours' WHERE token_hash = $1",
        [old.token],
      );
      await other.query("BEGIN");
      await other.query("SELECT 1 FROM player_login_challenge WHERE token_hash = $1 FOR UPDATE", [
        old.token,
      ]);
      const sweep = await sweepAlone();
      if (!sweep.waited) await sweep.run;
      const left = "SELECT 1 FROM player_login_challenge WHERE token_hash = $1";
      const kept = await owner(left, [old.token]);
      await other.query("COMMIT");
      await sweep.run;
      expect(sweep.waited).toBe(false);
      expect(kept).toHaveLength(1);
      await db.app.query("SELECT sweep_player_sign_in()");
      expect(await owner(left, [old.token])).toHaveLength(0);
    });

    it("sweeps rows of a family with no device row and sessions with no family (0184, test 21)", async () => {
      const p = await newPlayer();
      const rowless = randomUUID();
      await owner(
        `INSERT INTO player_refresh (player_id, family, token_hash, created_at, expires_at)
         VALUES ($1, $2, $3, now() - interval '200 days', now() - interval '8 days')`,
        [p.id, rowless, sha(bytes())],
      );
      await owner(
        `INSERT INTO player_session (player_id, token_hash, created_at, expires_at, refresh_family)
         VALUES ($1, $2, now() - interval '9 days', now() - interval '8 days', $3),
                ($1, $4, now() - interval '9 days', now() - interval '8 days', NULL)`,
        [p.id, sha(bytes()), rowless, sha(bytes())],
      );
      await db.app.query("SELECT sweep_player_sign_in()");
      expect(await rowsOf(rowless)).toEqual({ refresh: 0, access: 0, device: 0 });
      expect(
        await owner(
          "SELECT 1 FROM player_session WHERE player_id = $1 AND refresh_family IS NULL",
          [p.id],
        ),
      ).toHaveLength(0);
      expect(await liveIn(p.first.family)).toEqual({ refresh: 1, access: 1 });
    });
  });

  const staffUser = async (role: "none" | "admin" = "none") =>
    (
      await owner<{ id: string }>(
        "INSERT INTO staff_user (email, password_hash, platform_role) VALUES ($1, 'x', $2) RETURNING id",
        [`staff${randomUUID()}@example.com`, role],
      )
    )[0]?.id ?? "";
  const session = async (user: string, ageSeconds = 0) => {
    const token = bytes();
    const rows = await owner<{ id: string }>(
      `INSERT INTO staff_session (staff_user_id, token_hash, created_at)
       VALUES ($1, $2, now() - make_interval(secs => $3)) RETURNING id`,
      [user, token, ageSeconds],
    );
    return { id: rows[0]?.id ?? "", token };
  };
  const live = async (id: string) =>
    (
      await owner<{ live: boolean }>(
        "SELECT revoked_at IS NULL AS live FROM staff_session WHERE id = $1",
        [id],
      )
    )[0]?.live;

  const endAll = (who: { staff: string; admin?: boolean }, target: string, reason: string) =>
    as<{ n: number }>(who, "SELECT admin_end_staff_sessions($1, $2, $3) AS n", [
      target,
      reason,
      randomUUID(),
    ]).then((r) => r[0]?.n);

  describe("staff sessions", () => {
    it("ends another own session only when this one is fresh; a code confirmed elsewhere does not count", async () => {
      const user = await staffUser();
      const here = await session(user, 601);
      const laptop = await session(user, 601);
      const end = (from: { token: Buffer }, target: string) =>
        as<{ o: string }>({ staff: user }, "SELECT end_own_staff_session($1, $2, $3) AS o", [
          from.token,
          target,
          randomUUID(),
        ]).then((r) => r[0]?.o);
      expect(await end(here, laptop.id)).toBe("reauth_required");
      const token = bytes();
      const code = bytes();
      await as({ staff: user }, "SELECT * FROM start_staff_reauth($1, $2, $3)", [
        laptop.token,
        token,
        code,
      ]);
      const elsewhere = await as<{ outcome: string }>(
        { staff: user },
        "SELECT outcome FROM confirm_staff_reauth($1, $2, $3, $4)",
        [here.token, token, code, randomUUID()],
      );
      expect(elsewhere[0]?.outcome).toBe("expired");
      const confirmed = await as<{ outcome: string }>(
        { staff: user },
        "SELECT outcome FROM confirm_staff_reauth($1, $2, $3, $4)",
        [laptop.token, token, code, randomUUID()],
      );
      expect(confirmed[0]?.outcome).toBe("confirmed");
      expect(await end(laptop, here.id)).toBe("ended");
      expect(await live(here.id)).toBe(false);
      expect(await end(laptop, here.id)).toBe("not_found");
      expect(await end(laptop, laptop.id)).toBe("ended");
    });

    it("refuses a resend within 60 seconds and after three", async () => {
      const user = await staffUser();
      const here = await session(user);
      const ask = () =>
        as<{ outcome: string }>(
          { staff: user },
          "SELECT outcome FROM start_staff_reauth($1, $2, $3)",
          [here.token, bytes(), bytes()],
        ).then((r) => r[0]?.outcome);
      expect(await ask()).toBe("started");
      expect(await ask()).toBe("wait");
      for (let k = 0; k < 3; k += 1) {
        await owner(
          "UPDATE staff_reauth_challenge SET last_sent_at = now() - interval '61 seconds'",
        );
        expect(await ask()).toBe("started");
      }
      await owner("UPDATE staff_reauth_challenge SET last_sent_at = now() - interval '61 seconds'");
      expect(await ask()).toBe("too_many");
    });

    it("the API role cannot end, open or freshen a session itself", async () => {
      const user = await staffUser();
      const here = await session(user);
      const laptop = await session(user);
      await expect(
        as(
          { staff: user },
          "INSERT INTO staff_session (staff_user_id, token_hash) VALUES ($1, $2)",
          [user, bytes()],
        ),
      ).rejects.toThrow(/permission denied/);
      const updated = await as<{ id: string }>(
        { staff: user },
        "UPDATE staff_session SET revoked_at = now() WHERE id = $1 RETURNING id",
        [laptop.id],
      );
      expect(updated).toEqual([]);
      expect(await live(laptop.id)).toBe(true);
      await expect(
        as({ staff: user }, "UPDATE staff_session SET reauth_at = now() WHERE id = $1", [here.id]),
      ).rejects.toThrow(/permission denied/);
      await owner("UPDATE staff_session SET reauth_at = now() WHERE id = $1", [here.id]);
      await expect(
        owner("UPDATE staff_session SET reauth_at = now() - interval '1 hour' WHERE id = $1", [
          here.id,
        ]),
      ).rejects.toThrow(/reauth_at cannot move backwards/);
    });

    it("the console ends every session of one staff account, with a reason, audited with the count", async () => {
      const admin = await staffUser("admin");
      const member = await staffUser();
      await session(member);
      await session(member);
      await expect(endAll({ staff: member }, member, "a lost laptop")).rejects.toMatchObject({
        code: "QE403",
      });
      await expect(
        endAll({ staff: admin, admin: true }, admin, "a lost laptop"),
      ).rejects.toMatchObject({
        code: "QA422",
      });
      await expect(
        endAll({ staff: admin, admin: true }, randomUUID(), "a lost laptop"),
      ).rejects.toMatchObject({
        code: "QA404",
      });
      await expect(endAll({ staff: admin, admin: true }, member, "short")).rejects.toMatchObject({
        code: "SU400",
      });
      expect(
        await endAll({ staff: admin, admin: true }, member, "a lost laptop at the venue"),
      ).toBe(2);
      expect(
        await owner<{ after: unknown }>(
          "SELECT after FROM audit_log WHERE action = 'staff.session.end_all' AND target_id = $1",
          [member],
        ),
      ).toEqual([{ after: { reason: "a lost laptop at the venue", ended: 2 } }]);
    });
  });

  it("closes the new tables and the internal helpers to the API's role and everything to outsiders", async () => {
    for (const table of [
      "player_sign_in_device",
      "player_reauth_challenge",
      "staff_reauth_challenge",
    ]) {
      await expect(db.app.query(`SELECT * FROM public.${table}`)).rejects.toThrow(
        /permission denied/,
      );
      await expect(db.outsider.query(`SELECT * FROM public.${table}`)).rejects.toThrow(
        /permission denied/,
      );
    }
    for (const fn of [
      "end_family(gen_random_uuid())",
      "end_player_families(gen_random_uuid())",
      "player_current_device('\\x00')",
      "staff_current_session('\\x00')",
    ]) {
      await expect(db.app.query(`SELECT public.${fn}`)).rejects.toThrow(/permission denied/);
    }
    for (const fn of [
      "player_devices('\\x00')",
      "end_other_player_devices('\\x00', gen_random_uuid())",
      "label_player_device('\\x00', 'ios', NULL)",
      "end_other_staff_sessions('\\x00', gen_random_uuid())",
      "admin_end_staff_sessions(gen_random_uuid(), 'x', gen_random_uuid())",
    ]) {
      await expect(db.outsider.query(`SELECT * FROM public.${fn}`)).rejects.toThrow(
        /permission denied/,
      );
    }
  });
});
