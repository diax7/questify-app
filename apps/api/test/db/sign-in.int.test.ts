import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withPreIdentityContext, type Lookup } from "#src/db/pre-identity";
import { withRequestContext, type RequestContext } from "#src/db/context";
import { TEST_DATABASE_URL, createTestDatabase, type TestDatabase } from "#test/support/test-db";

const hash = (text: string): string => createHash("sha256").update(text).digest("hex");
const token = (): string => hash(randomBytes(16).toString("hex"));
const bytea = (hex: string): Buffer => Buffer.from(hex, "hex");

describe.skipIf(TEST_DATABASE_URL === undefined)("sign-in tables", () => {
  let db: TestDatabase;
  let sara: string;
  let khalid: string;
  const saraSession = token();
  const khalidSession = token();
  const saraChallenge = token();
  const khalidChallenge = token();

  beforeAll(async () => {
    db = await createTestDatabase();
    const one = async (sql: string, values: unknown[] = []): Promise<string> =>
      (await db.owner.query<{ id: string }>(sql, values)).rows[0]?.id ?? "";
    sara = await one(
      "INSERT INTO staff_user (email, password_hash) VALUES ('sara@x.sa', 'h') RETURNING id",
    );
    khalid = await one(
      "INSERT INTO staff_user (email, password_hash, platform_role) VALUES ('khalid@x.sa', 'h', 'admin') RETURNING id",
    );
    for (const [user, tokenHash] of [
      [sara, saraSession],
      [khalid, khalidSession],
    ] as const) {
      await db.owner.query(
        "INSERT INTO staff_session (staff_user_id, token_hash) VALUES ($1, $2)",
        [user, bytea(tokenHash)],
      );
    }
    for (const [user, tokenHash] of [
      [sara, saraChallenge],
      [khalid, khalidChallenge],
    ] as const) {
      await db.owner.query(
        `INSERT INTO staff_login_challenge (staff_user_id, token_hash, code_hash, expires_at)
         VALUES ($1, $2, $3, now() + interval '10 minutes')`,
        [user, bytea(tokenHash), bytea(token())],
      );
    }
  });
  afterAll(async () => {
    await db.close();
  });

  const asContext = <T>(context: RequestContext, sql: string, values: unknown[] = []) =>
    withRequestContext(db.app, context, async () => (await db.app.query(sql, values)).rows as T[]);
  const found = <T>(lookup: Lookup, sql: string, values: unknown[] = []) =>
    withPreIdentityContext(
      db.app,
      lookup,
      async () => (await db.app.query(sql, values)).rows as T[],
    );

  const promoted = <T>(sql: string, values: unknown[] = []) =>
    withPreIdentityContext(db.app, { kind: "email", email: "sara@x.sa" }, async ({ promote }) => {
      await promote(sara);
      return (await db.app.query(sql, values)).rows as T[];
    });

  describe("outsider (holds no rights)", () => {
    it.each(["staff_login_challenge", "staff_session", "auth_throttle"])(
      "cannot read or write %s",
      async (table) => {
        await expect(db.outsider.query(`SELECT * FROM public.${table}`)).rejects.toThrow(
          /permission denied/,
        );
        await expect(db.outsider.query(`DELETE FROM public.${table}`)).rejects.toThrow(
          /permission denied/,
        );
      },
    );
  });

  describe("with no context", () => {
    it.each(["staff_user", "staff_login_challenge", "staff_session"])(
      "shows no row of %s (an empty setting matches nothing)",
      async (table) => {
        expect(await asContext({}, `SELECT 1 FROM ${table}`)).toEqual([]);
      },
    );
  });

  describe("the pre-identity lookups open exactly one row", () => {
    it("finds an account by its email and nothing else", async () => {
      const rows = await found<{ email: string }>(
        { kind: "email", email: "sara@x.sa" },
        "SELECT email FROM staff_user",
      );
      expect(rows).toEqual([{ email: "sara@x.sa" }]);
    });

    it("finds nothing for an unknown email", async () => {
      expect(
        await found({ kind: "email", email: "nobody@x.sa" }, "SELECT email FROM staff_user"),
      ).toEqual([]);
    });

    it("opens only the session with that token hash", async () => {
      const rows = await found<{ staff_user_id: string }>(
        { kind: "session", tokenHash: saraSession },
        "SELECT staff_user_id FROM staff_session",
      );
      expect(rows).toEqual([{ staff_user_id: sara }]);
    });

    it("opens only the challenge with that token hash", async () => {
      const rows = await found<{ staff_user_id: string }>(
        { kind: "challenge", tokenHash: khalidChallenge },
        "SELECT staff_user_id FROM staff_login_challenge",
      );
      expect(rows).toEqual([{ staff_user_id: khalid }]);
    });

    it("does not let an email lookup open sessions or challenges", async () => {
      const lookup: Lookup = { kind: "email", email: "sara@x.sa" };
      expect(await found(lookup, "SELECT 1 FROM staff_session")).toEqual([]);
      expect(await found(lookup, "SELECT 1 FROM staff_login_challenge")).toEqual([]);
    });

    it("does not let a session lookup open accounts or challenges", async () => {
      const lookup: Lookup = { kind: "session", tokenHash: saraSession };
      expect(await found(lookup, "SELECT 1 FROM staff_user")).toEqual([]);
      expect(await found(lookup, "SELECT 1 FROM staff_login_challenge")).toEqual([]);
    });

    it("does not carry a lookup into the next transaction", async () => {
      await found({ kind: "email", email: "sara@x.sa" }, "SELECT 1");
      expect(await asContext({}, "SELECT 1 FROM staff_user")).toEqual([]);
    });
  });

  describe("a signed-in user", () => {
    it("lists only their own sessions", async () => {
      const rows = await asContext<{ staff_user_id: string }>(
        { staffUserId: sara },
        "SELECT staff_user_id FROM staff_session",
      );
      expect(rows).toEqual([{ staff_user_id: sara }]);
    });

    it("cannot list challenges by user, so no code hash is browsable", async () => {
      expect(await asContext({ staffUserId: sara }, "SELECT 1 FROM staff_login_challenge")).toEqual(
        [],
      );
    });

    it("cannot revoke someone else's session", async () => {
      await asContext(
        { staffUserId: sara },
        "UPDATE staff_session SET revoked_at = now() WHERE token_hash = $1",
        [bytea(khalidSession)],
      );
      const { rows } = await db.owner.query(
        "SELECT revoked_at FROM staff_session WHERE token_hash = $1",
        [bytea(khalidSession)],
      );
      expect(rows).toEqual([{ revoked_at: null }]);
    });

    it("lets an admin see every session", async () => {
      expect(await asContext({ isAdmin: true }, "SELECT 1 FROM staff_session")).toHaveLength(2);
    });

    it("creates a challenge only for themselves and can read it back by its own token", async () => {
      const mine = token();
      await expect(
        asContext(
          { staffUserId: sara },
          `INSERT INTO staff_login_challenge (staff_user_id, token_hash, code_hash, expires_at)
           VALUES ($1, $2, $3, now() + interval '10 minutes')`,
          [khalid, bytea(token()), bytea(token())],
        ),
      ).rejects.toThrow(/row-level security/);
      const rows = await withPreIdentityContext(
        db.app,
        { kind: "email", email: "sara@x.sa" },
        async ({ promote, openChallenge }) => {
          await promote(sara);
          await openChallenge(mine);
          return (
            await db.app.query(
              `INSERT INTO staff_login_challenge (staff_user_id, token_hash, code_hash, expires_at)
               VALUES ($1, $2, $3, now() + interval '10 minutes') RETURNING id`,
              [sara, bytea(mine), bytea(token())],
            )
          ).rows;
        },
      );
      expect(rows).toHaveLength(1);
    });

    it("can replace their own earlier challenges", async () => {
      const rows = await withPreIdentityContext(
        db.app,
        { kind: "email", email: "sara@x.sa" },
        async ({ promote }) => {
          await promote(sara);
          return (await db.app.query("DELETE FROM staff_login_challenge")).rowCount;
        },
      );
      expect(rows).toBeGreaterThanOrEqual(1);
      const { rows: left } = await db.owner.query(
        "SELECT 1 FROM staff_login_challenge WHERE staff_user_id = $1",
        [sara],
      );
      expect(left).toEqual([]);
      const { rows: others } = await db.owner.query(
        "SELECT 1 FROM staff_login_challenge WHERE staff_user_id = $1",
        [khalid],
      );
      expect(others).toHaveLength(1);
    });
  });

  describe("columns the API may write", () => {
    it("cannot promote an account to admin or disable it", async () => {
      await expect(
        promoted("UPDATE staff_user SET platform_role = 'admin' WHERE id = $1", [sara]),
      ).rejects.toThrow(/permission denied/);
      await expect(
        promoted("UPDATE staff_user SET status = 'disabled' WHERE id = $1", [sara]),
      ).rejects.toThrow(/permission denied/);
    });

    it("cannot create accounts", async () => {
      await expect(
        asContext(
          { isAdmin: true },
          "INSERT INTO staff_user (email, password_hash) VALUES ('new@x.sa', 'h')",
        ),
      ).rejects.toThrow(/permission denied/);
    });

    it("can change its own password hash", async () => {
      await promoted("UPDATE staff_user SET password_hash = 'newer' WHERE id = $1", [sara]);
      const { rows } = await db.owner.query("SELECT password_hash FROM staff_user WHERE id = $1", [
        sara,
      ]);
      expect(rows).toEqual([{ password_hash: "newer" }]);
    });

    it("can only touch last_seen_at and revoked_at on a session", async () => {
      await expect(
        promoted("UPDATE staff_session SET staff_user_id = $1 WHERE staff_user_id = $2", [
          khalid,
          sara,
        ]),
      ).rejects.toThrow(/permission denied/);
      await expect(promoted("UPDATE staff_session SET user_agent = 'x'")).rejects.toThrow(
        /permission denied/,
      );
      await promoted("UPDATE staff_session SET last_seen_at = now() WHERE staff_user_id = $1", [
        sara,
      ]);
    });

    it("cannot un-revoke a session or move last_seen_at backwards", async () => {
      const revoked = token();
      await db.owner.query(
        "INSERT INTO staff_session (staff_user_id, token_hash, revoked_at) VALUES ($1, $2, now())",
        [sara, bytea(revoked)],
      );
      await expect(
        found(
          { kind: "session", tokenHash: revoked },
          "UPDATE staff_session SET revoked_at = NULL",
        ),
      ).rejects.toThrow(/revoked session/);
      await expect(
        found(
          { kind: "session", tokenHash: saraSession },
          "UPDATE staff_session SET last_seen_at = now() - interval '1 hour'",
        ),
      ).rejects.toThrow(/backwards/);
    });

    it("only updates the challenge counters, and only by token", async () => {
      await expect(
        found(
          { kind: "challenge", tokenHash: khalidChallenge },
          "UPDATE staff_login_challenge SET expires_at = now() + interval '1 year'",
        ),
      ).rejects.toThrow(/permission denied/);
      const rows = await found<{ attempts: number }>(
        { kind: "challenge", tokenHash: khalidChallenge },
        "UPDATE staff_login_challenge SET attempts = attempts + 1 RETURNING attempts",
      );
      expect(rows).toEqual([{ attempts: 1 }]);
      await expect(
        found(
          { kind: "challenge", tokenHash: khalidChallenge },
          "UPDATE staff_login_challenge SET attempts = 6",
        ),
      ).rejects.toThrow(/check/);
    });
  });

  describe("retention sweep", () => {
    it("removes old sessions and challenges of any user, and keeps recent ones", async () => {
      const old = token();
      const stale = token();
      const fresh = token();
      await db.owner.query(
        `INSERT INTO staff_session (staff_user_id, token_hash, last_seen_at, revoked_at)
         VALUES ($1, $2, now() - interval '60 days', now() - interval '45 days'),
                ($1, $3, now() - interval '40 days', NULL),
                ($1, $4, now(), NULL)`,
        [khalid, bytea(old), bytea(stale), bytea(fresh)],
      );
      await db.owner.query(
        `INSERT INTO staff_login_challenge (staff_user_id, token_hash, code_hash, expires_at, created_at)
         VALUES ($1, $2, $3, now(), now() - interval '2 days')`,
        [khalid, bytea(token()), bytea(token())],
      );
      await asContext({}, "DELETE FROM staff_session");
      await asContext({}, "DELETE FROM staff_login_challenge");
      const { rows } = await db.owner.query<{ token_hash: Buffer }>(
        "SELECT token_hash FROM staff_session WHERE token_hash = ANY($1)",
        [[bytea(old), bytea(stale), bytea(fresh)]],
      );
      expect(rows.map((row) => row.token_hash.toString("hex"))).toEqual([fresh]);
      const { rows: challenges } = await db.owner.query(
        "SELECT 1 FROM staff_login_challenge WHERE created_at < now() - interval '1 day'",
      );
      expect(challenges).toEqual([]);
    });
  });

  describe("throttle", () => {
    it("lets the API record, count and clear attempts without any identity", async () => {
      const key = bytea(token());
      await asContext({}, "INSERT INTO auth_throttle (bucket, key) VALUES ('fail_email', $1)", [
        key,
      ]);
      expect(await asContext({}, "SELECT 1 FROM auth_throttle WHERE key = $1", [key])).toHaveLength(
        1,
      );
      await asContext({}, "DELETE FROM auth_throttle WHERE key = $1", [key]);
      expect(await asContext({}, "SELECT 1 FROM auth_throttle WHERE key = $1", [key])).toEqual([]);
    });

    it("refuses a key that is not 32 bytes", async () => {
      await expect(
        asContext({}, "INSERT INTO auth_throttle (bucket, key) VALUES ('fail_email', $1)", [
          Buffer.from("short"),
        ]),
      ).rejects.toThrow(/check/);
    });
  });
});
