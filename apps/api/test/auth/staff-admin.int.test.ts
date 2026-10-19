import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAuthKeys } from "#src/auth/keys";
import { verifyPassword } from "#src/auth/password";
import { clearThrottleFor, createStaffAccount } from "#src/auth/staff-admin";
import { BUCKETS, record } from "#src/auth/throttle";
import { testConfig } from "#test/support/auth-app";
import { TEST_DATABASE_URL, createTestDatabase, type TestDatabase } from "#test/support/test-db";

describe.skipIf(TEST_DATABASE_URL === undefined)("staff account administration", () => {
  let db: TestDatabase;
  const keys = createAuthKeys(testConfig().auth.secret);

  beforeAll(async () => {
    db = await createTestDatabase();
  });
  afterAll(async () => {
    await db.close();
  });

  const strong = "a long enough password";

  it("creates an account with a hashed password and the right role", async () => {
    const id = await createStaffAccount(db.owner, {
      email: "  New.Person@Najd.SA ",
      password: strong,
      admin: false,
    });
    const { rows } = await db.owner.query<{
      email: string;
      password_hash: string;
      platform_role: string;
      status: string;
    }>("SELECT email, password_hash, platform_role, status FROM staff_user WHERE id = $1", [id]);
    expect(rows[0]).toMatchObject({
      email: "new.person@najd.sa",
      platform_role: "none",
      status: "active",
    });
    expect(rows[0]?.password_hash).not.toContain(strong);
    expect(await verifyPassword(rows[0]?.password_hash ?? "", strong)).toBe(true);
  });

  it("creates an admin when asked", async () => {
    const id = await createStaffAccount(db.owner, {
      email: "boss@najd.sa",
      password: strong,
      admin: true,
    });
    const { rows } = await db.owner.query(
      "SELECT 1 FROM staff_user WHERE id = $1 AND platform_role = 'admin'",
      [id],
    );
    expect(rows).toHaveLength(1);
  });

  it.each([
    ["not an email", "nobody", strong, /valid email/],
    ["an email without a domain dot", "a@b", strong, /valid email/],
    ["a short password", "short@najd.sa", "elevenchars", /at least 12/],
    ["a long password", "long@najd.sa", "x".repeat(129), /at most 128/],
    [
      "the email as the password",
      "same.as.email@najd.sa",
      "same.as.email@najd.sa",
      /must not be the email/,
    ],
  ])("refuses %s", async (_label, email, password, message) => {
    await expect(createStaffAccount(db.owner, { email, password, admin: false })).rejects.toThrow(
      message,
    );
    const { rows } = await db.owner.query("SELECT 1 FROM staff_user WHERE email = $1", [email]);
    expect(rows).toEqual([]);
  });

  it("explains that an account already exists, whatever the capitalisation", async () => {
    await createStaffAccount(db.owner, { email: "twice@najd.sa", password: strong, admin: false });
    await expect(
      createStaffAccount(db.owner, { email: "TWICE@najd.sa", password: strong, admin: false }),
    ).rejects.toThrow(/already exists/);
  });

  it("keeps the real cause of an account that already exists", async () => {
    await createStaffAccount(db.owner, { email: "cause@najd.sa", password: strong, admin: false });
    const error = await createStaffAccount(db.owner, {
      email: "cause@najd.sa",
      password: strong,
      admin: false,
    }).catch((caught: unknown) => caught);
    expect((error as Error).cause).toMatchObject({ code: "23505" });
  });

  it("passes any other database failure through instead of calling it a duplicate", async () => {
    const broken = {
      query: async () => {
        throw new Error("connection lost");
      },
    } as unknown as Client;
    await expect(
      createStaffAccount(broken, { email: "x@najd.sa", password: strong, admin: false }),
    ).rejects.toThrow("connection lost");
  });

  it("clears a person's failure count and challenge count", async () => {
    const id = await createStaffAccount(db.owner, {
      email: "locked@najd.sa",
      password: strong,
      admin: false,
    });
    for (let count = 0; count < 3; count += 1) {
      await record(db.owner, BUCKETS.failEmail, keys.emailKey("locked@najd.sa"));
      await record(db.owner, BUCKETS.challengeUser, keys.userKey(id));
    }
    await record(db.owner, BUCKETS.failEmail, keys.emailKey("someone.else@najd.sa"));

    expect(await clearThrottleFor(db.owner, keys, " LOCKED@najd.sa ")).toBe(true);
    const { rows } = await db.owner.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM auth_throttle WHERE key = ANY($1)",
      [[keys.emailKey("locked@najd.sa"), keys.userKey(id)]],
    );
    expect(rows[0]?.n).toBe(0);
    const others = await db.owner.query("SELECT 1 FROM auth_throttle WHERE key = $1", [
      keys.emailKey("someone.else@najd.sa"),
    ]);
    expect(others.rows).toHaveLength(1);
  });

  it("reports an unknown email but still clears its failure count", async () => {
    await record(db.owner, BUCKETS.failEmail, keys.emailKey("ghost@najd.sa"));
    expect(await clearThrottleFor(db.owner, keys, "ghost@najd.sa")).toBe(false);
    const { rows } = await db.owner.query("SELECT 1 FROM auth_throttle WHERE key = $1", [
      keys.emailKey("ghost@najd.sa"),
    ]);
    expect(rows).toEqual([]);
  });
});
