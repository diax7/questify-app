import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_DATABASE_URL, createTestDatabase, type TestDatabase } from "#test/support/test-db";

const bytes = () => randomBytes(32);
const sha = (value: Buffer) => createHash("sha256").update(value).digest();

type Tokens = { access: Buffer; refresh: Buffer; family: string };
const tokens = (): Tokens => ({ access: bytes(), refresh: bytes(), family: randomUUID() });

/**
 * Player sign-in in the database (T-107, migration 0013): every session comes from proof the database consumes (a code,
 * a signup token, a refresh token), never from a bare player id; refresh tokens rotate with a short retry grace and a
 * theft alarm; challenges and tokens are closed to everyone but the functions.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("player sign-in (database)", () => {
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
  const call = async <T extends Record<string, unknown>>(
    sql: string,
    values: unknown[] = [],
    client = db.app,
  ) => (await client.query<T>(sql, values)).rows;

  type Challenge = { token: Buffer; code: Buffer; contact: string; key: Buffer };

  /** A live challenge for a new phone number (or the given contact). */
  const challenge = async (
    contact?: string,
    channel: "phone" | "email" = "phone",
  ): Promise<Challenge> => {
    counter += 1;
    const value = contact ?? `+96655${String(1_000_000 + counter).slice(-7)}`;
    const made = { token: bytes(), code: bytes(), contact: value, key: sha(Buffer.from(value)) };
    await call("SELECT start_player_challenge($1, $2, $3, $4, $5, $6, '0.1', '0.1')", [
      randomUUID(),
      made.token,
      channel,
      value,
      made.key,
      made.code,
    ]);
    return made;
  };

  const signIn = async (
    c: Challenge,
    code: Buffer = c.code,
    t: Tokens = tokens(),
    signup = bytes(),
    client = db.app,
  ) =>
    (
      await call<{ outcome: string; attempts_left: number; player_id: string | null }>(
        "SELECT * FROM sign_in_player($1, $2, $3, $4, $5, $6)",
        [c.token, code, sha(t.access), sha(t.refresh), t.family, sha(signup)],
        client,
      )
    )[0];

  const createPlayer = async (signup: Buffer, name: string, born: number, t: Tokens = tokens()) =>
    (
      await call<{ outcome: string; player_id: string | null }>(
        "SELECT * FROM create_player($1, $2, $3, 'falcon', $4, $5, $6)",
        [sha(signup), name, born, sha(t.access), sha(t.refresh), t.family],
      )
    )[0];

  const ownerOf = async (access: Buffer) =>
    (
      await call<{ owner: string | null }>("SELECT player_session_owner($1) AS owner", [
        sha(access),
      ])
    )[0]?.owner;

  /** A player with a phone, signed up through the functions; returns its tokens. */
  const newPlayer = async (): Promise<{ id: string; phone: string; t: Tokens }> => {
    const c = await challenge();
    const signup = bytes();
    expect(await signIn(c, c.code, tokens(), signup)).toMatchObject({ outcome: "new" });
    const t = tokens();
    counter += 1;
    const made = await createPlayer(signup, `runner_${counter}`, 1995, t);
    return { id: made?.player_id ?? "", phone: c.contact, t };
  };

  const rotate = async (presented: Buffer, next: Tokens = tokens(), client = db.app) =>
    (
      await call<{ outcome: string; player_id: string | null }>(
        "SELECT * FROM rotate_player_refresh($1, $2, $3)",
        [sha(presented), sha(next.access), sha(next.refresh)],
        client,
      )
    )[0];

  describe("a code", () => {
    it("takes three tries, says how many are left, and then ends", async () => {
      const c = await challenge();
      for (const left of [2, 1, 0]) {
        expect(await signIn(c, bytes())).toEqual({
          outcome: "wrong",
          attempts_left: left,
          player_id: null,
        });
      }
      expect(await signIn(c)).toMatchObject({ outcome: "expired" });
    });

    it("counts parallel wrong guesses one after the other: never more than three", async () => {
      const c = await challenge();
      const clients = await Promise.all(
        Array.from({ length: 10 }, async () => {
          const client = new Client({ connectionString: db.appUrl });
          await client.connect();
          return client;
        }),
      );
      try {
        const answers = await Promise.all(
          clients.map((client) => signIn(c, bytes(), tokens(), bytes(), client)),
        );
        expect(answers.filter((answer) => answer?.outcome === "wrong")).toHaveLength(3);
      } finally {
        await Promise.all(clients.map((client) => client.end()));
      }
      const [row] = await owner<{ attempts: number }>(
        "SELECT attempts FROM player_login_challenge WHERE token_hash = $1",
        [c.token],
      );
      expect(row?.attempts).toBe(3);
    });

    it("ends when a new code is asked for the same contact (one live code per contact)", async () => {
      const first = await challenge();
      await call("SELECT start_player_challenge($1, $2, 'phone', $3, $4, $5, '0.1', '0.1')", [
        randomUUID(),
        bytes(),
        first.contact,
        first.key,
        bytes(),
      ]);
      expect(await signIn(first)).toMatchObject({ outcome: "expired" });
    });

    it("ends when cancelled (the email fallback), and a cancel of a finished one changes nothing", async () => {
      const c = await challenge();
      await call("SELECT cancel_player_challenge($1)", [c.token]);
      expect(await signIn(c)).toMatchObject({ outcome: "expired" });
      await call("SELECT cancel_player_challenge($1)", [bytes()]);
    });

    it("holds only a Saudi mobile or a lowercase email address", async () => {
      for (const [channel, value] of [
        ["phone", "0551234567"],
        ["phone", "+96612345678"],
        ["email", "Name@Example.com"],
        ["email", "@example.com"],
      ]) {
        await expect(
          call("SELECT start_player_challenge($1, $2, $3, $4, $5, $6, '0.1', '0.1')", [
            randomUUID(),
            bytes(),
            channel,
            value,
            bytes(),
            bytes(),
          ]),
        ).rejects.toThrow(/check constraint/);
      }
      await challenge("name@example.com", "email");
    });

    it("ends after five minutes", async () => {
      const c = await challenge();
      await owner(
        "UPDATE player_login_challenge SET expires_at = now() - interval '1 second' WHERE token_hash = $1",
        [c.token],
      );
      expect(await signIn(c)).toMatchObject({ outcome: "expired" });
    });

    it("can be sent again three times, 60 seconds apart, with fresh tries each time", async () => {
      const c = await challenge();
      const resend = (code: Buffer) =>
        call<{ ok: boolean }>("SELECT resend_player_challenge($1, $2) AS ok", [c.token, code]);
      expect(await resend(bytes())).toEqual([{ ok: false }]);
      let code = c.code;
      for (let n = 0; n < 3; n += 1) {
        await signIn(c, bytes());
        await owner(
          "UPDATE player_login_challenge SET last_sent_at = now() - interval '61 seconds' WHERE token_hash = $1",
          [c.token],
        );
        code = bytes();
        expect(await resend(code)).toEqual([{ ok: true }]);
      }
      await owner(
        "UPDATE player_login_challenge SET last_sent_at = now() - interval '61 seconds' WHERE token_hash = $1",
        [c.token],
      );
      expect(await resend(bytes())).toEqual([{ ok: false }]);
      expect(await signIn(c, code)).toMatchObject({ outcome: "new" });
    });
  });

  describe("signing up and in", () => {
    it("creates the player, its contact and its tokens from the signup token, and audits it", async () => {
      const { id, phone, t } = await newPlayer();
      expect(await ownerOf(t.access)).toBe(id);
      expect(
        await owner("SELECT phone_e164 FROM player_contact WHERE player_id = $1", [id]),
      ).toEqual([{ phone_e164: phone }]);
      expect(await owner("SELECT action FROM audit_log WHERE target_id = $1", [id])).toEqual([
        { action: "player.signup" },
      ]);
    });

    it("signs in a returning player and uses the challenge up", async () => {
      const { id, phone } = await newPlayer();
      const c = await challenge(phone);
      const t = tokens();
      expect(await signIn(c, c.code, t)).toEqual({
        outcome: "signed_in",
        attempts_left: 0,
        player_id: id,
      });
      expect(await ownerOf(t.access)).toBe(id);
      expect(await signIn(c)).toMatchObject({ outcome: "expired" });
    });

    it("issues nothing to a banned player, after a right code", async () => {
      const { id, phone } = await newPlayer();
      await owner("UPDATE player SET status = 'banned' WHERE id = $1", [id]);
      const c = await challenge(phone);
      const t = tokens();
      expect(await signIn(c, c.code, t)).toMatchObject({ outcome: "banned", player_id: null });
      expect(
        await owner("SELECT 1 FROM player_session WHERE token_hash = $1", [sha(t.access)]),
      ).toEqual([]);
    });

    it("refuses an under-13 by year in Riyadh and uses the token up; nothing is created", async () => {
      const c = await challenge();
      const signup = bytes();
      await signIn(c, c.code, tokens(), signup);
      const year = Number(
        new Intl.DateTimeFormat("en", { timeZone: "Asia/Riyadh", year: "numeric" }).format(
          new Date(),
        ),
      );
      expect(await createPlayer(signup, "too_young_one", year - 12)).toEqual({
        outcome: "too_young",
        player_id: null,
      });
      expect(await createPlayer(signup, "too_young_one", year - 30)).toMatchObject({
        outcome: "expired",
      });
      expect(await owner("SELECT 1 FROM player WHERE username = 'too_young_one'")).toEqual([]);
    });

    it("refuses a birth year before 1900 or after this year, and keeps the token", async () => {
      const c = await challenge();
      const signup = bytes();
      await signIn(c, c.code, tokens(), signup);
      const year = Number(
        new Intl.DateTimeFormat("en", { timeZone: "Asia/Riyadh", year: "numeric" }).format(
          new Date(),
        ),
      );
      for (const born of [1899, year + 1]) {
        expect(await createPlayer(signup, `born_${counter}`, born)).toEqual({
          outcome: "invalid_birth_year",
          player_id: null,
        });
      }
      expect(await createPlayer(signup, `born_${counter}`, 1900)).toMatchObject({
        outcome: "created",
      });
    });

    it("refuses a sign-in without a signup token hash (a programming error)", async () => {
      const c = await challenge();
      const t = tokens();
      await expect(
        call("SELECT * FROM sign_in_player($1, $2, $3, $4, $5, NULL)", [
          c.token,
          c.code,
          sha(t.access),
          sha(t.refresh),
          t.family,
        ]),
      ).rejects.toThrow(/signup token hash/);
    });

    it("keeps the token for another name when the name is taken, ignoring case", async () => {
      const taken = await newPlayer();
      const [row] = await owner<{ username: string }>("SELECT username FROM player WHERE id = $1", [
        taken.id,
      ]);
      const c = await challenge();
      const signup = bytes();
      await signIn(c, c.code, tokens(), signup);
      expect(await createPlayer(signup, (row?.username ?? "").toUpperCase(), 1990)).toMatchObject({
        outcome: "username_taken",
      });
      expect(await createPlayer(signup, `fresh_${counter}`, 1990)).toMatchObject({
        outcome: "created",
      });
    });

    it("answers contact_taken when the same contact signed up in parallel", async () => {
      const c = await challenge();
      const signup = bytes();
      await signIn(c, c.code, tokens(), signup);
      const [first] = await owner<{ id: string }>(
        "INSERT INTO player (username) VALUES ('raced_in') RETURNING id",
      );
      await owner("INSERT INTO player_contact (player_id, phone_e164) VALUES ($1, $2)", [
        first?.id,
        c.contact,
      ]);
      expect(await createPlayer(signup, "raced_second", 1990)).toEqual({
        outcome: "contact_taken",
        player_id: null,
      });
      expect(await owner("SELECT 1 FROM player WHERE username = 'raced_second'")).toEqual([]);
    });

    it("refuses a signup token that is unknown or past its 15 minutes", async () => {
      expect(await createPlayer(bytes(), "nobody_here", 1990)).toMatchObject({
        outcome: "expired",
      });
      const c = await challenge();
      const signup = bytes();
      await signIn(c, c.code, tokens(), signup);
      await owner(
        "UPDATE player_login_challenge SET signup_expires_at = now() - interval '1 second' WHERE signup_hash = $1",
        [sha(signup)],
      );
      expect(await createPlayer(signup, "late_one", 1990)).toMatchObject({ outcome: "expired" });
    });
  });

  describe("refresh tokens", () => {
    it("rotate: the new pair works and the old access token ends", async () => {
      const { id, t } = await newPlayer();
      const next = tokens();
      expect(await rotate(t.refresh, next)).toEqual({ outcome: "rotated", player_id: id });
      expect(await ownerOf(next.access)).toBe(id);
      expect(await ownerOf(t.access)).toBeNull();
    });

    it("forgive a retry within 60 seconds while the successor is unused: the successor is replaced", async () => {
      const { id, t } = await newPlayer();
      const lost = tokens();
      await rotate(t.refresh, lost);
      const retry = tokens();
      expect(await rotate(t.refresh, retry)).toEqual({ outcome: "rotated", player_id: id });
      expect(await ownerOf(retry.access)).toBe(id);
      expect(await ownerOf(lost.access)).toBeNull();
    });

    it("treat a reuse after the successor was used, or after 60 seconds, as theft: the family ends, audited", async () => {
      for (const late of [false, true]) {
        const { id, t } = await newPlayer();
        const next = tokens();
        await rotate(t.refresh, next);
        if (late) {
          await owner(
            "UPDATE player_refresh SET used_at = now() - interval '61 seconds' WHERE token_hash = $1",
            [sha(t.refresh)],
          );
        } else {
          await rotate(next.refresh);
        }
        expect(await rotate(t.refresh)).toMatchObject({ outcome: "reused" });
        expect(
          await owner(
            "SELECT count(*)::int AS live FROM player_refresh WHERE player_id = $1 AND revoked_at IS NULL",
            [id],
          ),
        ).toEqual([{ live: 0 }]);
        expect(
          await owner(
            "SELECT 1 FROM audit_log WHERE target_id = $1 AND action = 'player.refresh_reuse'",
            [id],
          ),
        ).toHaveLength(1);
      }
    });

    it("treat a replaced retry's token, shown again while its family lives, as theft", async () => {
      const { id, t } = await newPlayer();
      const lost = tokens();
      await rotate(t.refresh, lost);
      await rotate(t.refresh);
      expect(await rotate(lost.refresh)).toMatchObject({ outcome: "reused" });
      expect(
        await owner(
          "SELECT count(*)::int AS live FROM player_refresh WHERE player_id = $1 AND revoked_at IS NULL",
          [id],
        ),
      ).toEqual([{ live: 0 }]);
      expect(
        await owner(
          "SELECT 1 FROM audit_log WHERE target_id = $1 AND action = 'player.refresh_reuse'",
          [id],
        ),
      ).toHaveLength(1);
      expect(await rotate(lost.refresh)).toMatchObject({ outcome: "invalid" });
    });

    it("end, with the family, for a player who is no longer active", async () => {
      const { id, t } = await newPlayer();
      await owner("UPDATE player SET status = 'banned' WHERE id = $1", [id]);
      expect(await rotate(t.refresh)).toMatchObject({ outcome: "invalid" });
      expect(
        await owner(
          "SELECT count(*)::int AS live FROM player_refresh WHERE player_id = $1 AND revoked_at IS NULL",
          [id],
        ),
      ).toEqual([{ live: 0 }]);
    });

    it("leave exactly one live pair when two retries arrive at once", async () => {
      const { id, t } = await newPlayer();
      const clients = await Promise.all(
        [0, 1].map(async () => {
          const client = new Client({ connectionString: db.appUrl });
          await client.connect();
          return client;
        }),
      );
      try {
        await Promise.all(clients.map((client) => rotate(t.refresh, tokens(), client)));
      } finally {
        await Promise.all(clients.map((client) => client.end()));
      }
      const [live] = await owner<{ refresh: number; sessions: number }>(
        `SELECT (SELECT count(*)::int FROM player_refresh WHERE player_id = $1 AND revoked_at IS NULL AND used_at IS NULL) AS refresh,
                (SELECT count(*)::int FROM player_session WHERE player_id = $1 AND revoked_at IS NULL) AS sessions`,
        [id],
      );
      expect(live).toEqual({ refresh: 1, sessions: 1 });
    });
  });

  describe("signing out and limits", () => {
    it("ends this device's session and its family by the refresh token, not the player's other devices", async () => {
      const { id, phone, t } = await newPlayer();
      const c = await challenge(phone);
      const other = tokens();
      await signIn(c, c.code, other);
      await call("SELECT sign_out_player($1)", [sha(t.refresh)]);
      expect(await ownerOf(t.access)).toBeNull();
      expect(await rotate(t.refresh)).toMatchObject({ outcome: "invalid" });
      expect(await ownerOf(other.access)).toBe(id);
      await call("SELECT sign_out_player($1)", [bytes()]);
      expect(await ownerOf(other.access)).toBe(id);
    });

    it("keeps at most 10 devices: the oldest is signed out", async () => {
      const { id, phone, t } = await newPlayer();
      for (let n = 0; n < 10; n += 1) {
        const c = await challenge(phone);
        await signIn(c);
      }
      expect(await ownerOf(t.access)).toBeNull();
      expect(
        await owner(
          "SELECT count(DISTINCT family)::int AS live FROM player_refresh WHERE player_id = $1 AND revoked_at IS NULL",
          [id],
        ),
      ).toEqual([{ live: 10 }]);
    });

    it("sweeps refresh tokens used more than 7 days ago, keeping the live successor", async () => {
      const { id, t } = await newPlayer();
      const next = tokens();
      await rotate(t.refresh, next);
      await owner(
        "UPDATE player_refresh SET used_at = now() - interval '8 days' WHERE token_hash = $1",
        [sha(t.refresh)],
      );
      await call("SELECT sweep_player_sign_in()");
      expect(
        await owner("SELECT 1 FROM player_refresh WHERE token_hash = $1", [sha(t.refresh)]),
      ).toEqual([]);
      expect(await rotate(next.refresh)).toMatchObject({ outcome: "rotated", player_id: id });
    });

    it("sweeps old challenges and ended tokens", async () => {
      const c = await challenge();
      const { t } = await newPlayer();
      await owner(
        "UPDATE player_login_challenge SET expires_at = now() - interval '2 hours' WHERE token_hash = $1",
        [c.token],
      );
      await call("SELECT sign_out_player($1)", [sha(t.refresh)]);
      await owner(
        "UPDATE player_session SET revoked_at = now() - interval '8 days' WHERE token_hash = $1",
        [sha(t.access)],
      );
      await owner(
        "UPDATE player_refresh SET revoked_at = now() - interval '8 days' WHERE token_hash = $1",
        [sha(t.refresh)],
      );
      await call("SELECT sweep_player_sign_in()");
      expect(
        await owner("SELECT 1 FROM player_login_challenge WHERE token_hash = $1", [c.token]),
      ).toEqual([]);
      expect(
        await owner("SELECT 1 FROM player_session WHERE token_hash = $1", [sha(t.access)]),
      ).toEqual([]);
      expect(
        await owner("SELECT 1 FROM player_refresh WHERE token_hash = $1", [sha(t.refresh)]),
      ).toEqual([]);
    });
  });

  describe("who can touch it", () => {
    it("closes the tables to the API's role and everything to outsiders", async () => {
      for (const table of ["player_login_challenge", "player_refresh"]) {
        await expect(db.app.query(`SELECT * FROM ${table}`)).rejects.toThrow(/permission denied/);
        await expect(db.outsider.query(`SELECT * FROM public.${table}`)).rejects.toThrow(
          /permission denied/,
        );
      }
      for (const fn of [
        "issue_player_tokens(gen_random_uuid(), '\\x00', '\\x00', gen_random_uuid())",
        "revoke_family(gen_random_uuid())",
      ]) {
        await expect(db.app.query(`SELECT public.${fn}`)).rejects.toThrow(/permission denied/);
      }
      for (const fn of [
        "start_player_challenge(gen_random_uuid(), '\\x00', 'phone', 'x', '\\x00', '\\x00', '0.1', '0.1')",
        "sign_in_player('\\x00', '\\x00', '\\x00', '\\x00', gen_random_uuid(), '\\x00')",
        "create_player('\\x00', 'x', 1990, 'falcon', '\\x00', '\\x00', gen_random_uuid())",
        "rotate_player_refresh('\\x00', '\\x00', '\\x00')",
        "sign_out_player('\\x00')",
        "sweep_player_sign_in()",
      ]) {
        await expect(db.outsider.query(`SELECT public.${fn}`)).rejects.toThrow(/permission denied/);
      }
    });

    it("pins every definer function's search path with pg_temp last, so a temp table cannot shadow a table", async () => {
      const loose = await owner<{ fn: string }>(
        `SELECT p.oid::regprocedure::text AS fn FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.prosecdef
           AND NOT ('search_path=public, pg_temp' = ANY (coalesce(p.proconfig, '{}')))`,
      );
      expect(loose).toEqual([]);
    });

    it("refuses temporary tables to the API's role and to outsiders", async () => {
      for (const client of [db.app, db.outsider]) {
        await expect(client.query("CREATE TEMP TABLE shadow (id int)")).rejects.toThrow(
          /permission denied/,
        );
      }
    });
  });
});
