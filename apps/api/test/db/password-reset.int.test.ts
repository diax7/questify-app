import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withRequestContext } from "#src/db/context";
import { withPreIdentityContext, type Lookup } from "#src/db/pre-identity";
import { TEST_DATABASE_URL, createTestDatabase, type TestDatabase } from "#test/support/test-db";

const hash = (text: string): string => createHash("sha256").update(text).digest("hex");
const token = (): string => hash(randomBytes(16).toString("hex"));
const bytea = (hex: string): Buffer => Buffer.from(hex, "hex");

describe.skipIf(TEST_DATABASE_URL === undefined)("password reset links (T-020)", () => {
  let db: TestDatabase;
  let sara: string;
  let khalid: string;

  const one = async (sql: string, values: unknown[] = []): Promise<string> =>
    (await db.owner.query<{ id: string }>(sql, values)).rows[0]?.id ?? "";

  const addLink = async (
    user: string,
    tokenHash = token(),
    when = { expires: "now() + interval '30 minutes'", created: "now()" },
  ): Promise<string> => {
    await db.owner.query(
      `INSERT INTO staff_password_reset (staff_user_id, token_hash, expires_at, created_at)
       VALUES ($1, $2, ${when.expires}, ${when.created})`,
      [user, bytea(tokenHash)],
    );
    return tokenHash;
  };

  const linksOf = async (user: string): Promise<number> =>
    (await db.owner.query("SELECT 1 FROM staff_password_reset WHERE staff_user_id = $1", [user]))
      .rowCount ?? 0;

  const found = <T>(lookup: Lookup, sql: string, values: unknown[] = []) =>
    withPreIdentityContext(
      db.app,
      lookup,
      async () => (await db.app.query(sql, values)).rows as T[],
    );

  beforeAll(async () => {
    db = await createTestDatabase();
    sara = await one(
      "INSERT INTO staff_user (email, password_hash) VALUES ('sara@x.sa', 'h') RETURNING id",
    );
    khalid = await one(
      "INSERT INTO staff_user (email, password_hash) VALUES ('khalid@x.sa', 'h') RETURNING id",
    );
  });
  afterAll(async () => {
    await db.close();
  });

  it("is closed to an outsider, table and setting function alike", async () => {
    await expect(db.outsider.query("SELECT * FROM public.staff_password_reset")).rejects.toThrow(
      /permission denied/,
    );
    await expect(db.outsider.query("DELETE FROM public.staff_password_reset")).rejects.toThrow(
      /permission denied/,
    );
    await expect(db.outsider.query("SELECT public.app_reset_token_hash()")).rejects.toThrow(
      /permission denied/,
    );
  });

  it("shows nothing without a token, even to the link's own user", async () => {
    await addLink(sara);
    const rows = await withRequestContext(
      db.app,
      { staffUserId: sara },
      async () => (await db.app.query("SELECT 1 FROM staff_password_reset")).rows,
    );
    expect(rows).toEqual([]);
  });

  it("opens exactly the link with that token hash, and nothing else", async () => {
    const saraLink = await addLink(sara);
    await addLink(khalid);
    const lookup: Lookup = { kind: "reset", tokenHash: saraLink };
    expect(
      await found<{ staff_user_id: string }>(
        lookup,
        "SELECT staff_user_id FROM staff_password_reset",
      ),
    ).toEqual([{ staff_user_id: sara }]);
    expect(await found(lookup, "SELECT 1 FROM staff_user")).toEqual([]);
    expect(await found(lookup, "SELECT 1 FROM staff_session")).toEqual([]);
    expect(await found(lookup, "SELECT 1 FROM staff_login_challenge")).toEqual([]);
  });

  it("has no update right: a link is used up by deleting it", async () => {
    const link = await addLink(sara);
    await expect(
      found(
        { kind: "reset", tokenHash: link },
        "UPDATE staff_password_reset SET expires_at = now() + interval '1 year'",
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it("deletes only the token's own link when the delete names a condition", async () => {
    const link = await addLink(khalid);
    const before = await linksOf(khalid);
    const deleted = await found<{ staff_user_id: string }>(
      { kind: "reset", tokenHash: link },
      "DELETE FROM staff_password_reset WHERE expires_at > now() RETURNING staff_user_id",
    );
    expect(deleted).toEqual([{ staff_user_id: khalid }]);
    expect(await linksOf(khalid)).toBe(before - 1);
  });

  it("does not delete an expired link through the token (the database clock decides)", async () => {
    const link = await addLink(khalid, token(), {
      expires: "now() - interval '1 second'",
      created: "now()",
    });
    const deleted = await found(
      { kind: "reset", tokenHash: link },
      "DELETE FROM staff_password_reset WHERE expires_at > now() RETURNING id",
    );
    expect(deleted).toEqual([]);
  });

  it("lets a promoted user remove all their own links with a bare delete, and no one else's", async () => {
    await addLink(sara);
    const khalidBefore = await linksOf(khalid);
    await withPreIdentityContext(
      db.app,
      { kind: "email", email: "sara@x.sa" },
      async ({ promote }) => {
        await promote(sara);
        await db.app.query("DELETE FROM staff_password_reset");
      },
    );
    expect(await linksOf(sara)).toBe(0);
    expect(await linksOf(khalid)).toBe(khalidBefore);
  });

  it("creates a link only for the promoted user", async () => {
    await expect(
      withRequestContext(db.app, { staffUserId: sara }, () =>
        db.app.query(
          `INSERT INTO staff_password_reset (staff_user_id, token_hash, expires_at)
           VALUES ($1, $2, now() + interval '30 minutes')`,
          [khalid, bytea(token())],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("lets the retention sweep remove links older than a day, of any user", async () => {
    const old = await addLink(khalid, token(), {
      expires: "now() - interval '2 days'",
      created: "now() - interval '2 days'",
    });
    const recent = await addLink(khalid);
    await withRequestContext(db.app, {}, () => db.app.query("DELETE FROM staff_password_reset"));
    const { rows } = await db.owner.query<{ token_hash: Buffer }>(
      "SELECT token_hash FROM staff_password_reset WHERE token_hash = ANY($1)",
      [[bytea(old), bytea(recent)]],
    );
    expect(rows.map((row) => row.token_hash.toString("hex"))).toEqual([recent]);
  });
});
