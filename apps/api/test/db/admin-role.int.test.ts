import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setPlatformAdmin } from "#src/auth/staff-admin";
import { withRequestContext, type RequestContext } from "#src/db/context";
import {
  TEST_DATABASE_URL,
  addMember,
  createTestDatabase,
  seedTwoTenants,
  type TestDatabase,
} from "#test/support/test-db";

type Row = Record<string, unknown>;

const SRC = join(import.meta.dirname, "..", "..", "src");

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        return sourceFiles(path);
      }
      return Promise.resolve(entry.name.endsWith(".ts") ? [path] : []);
    }),
  );
  return nested.flat();
}

/**
 * The admin role (T-701, ADR-405): only the owner connection grants or revokes it, audited; a revoke ends the account's
 * sessions and support grants; no API context can write it; an admin no longer writes another person's password.
 */
const GRANT_NOTE = { reason: "Joins the support rota on 2026-11-02", by: "dhia" };
const REVOKE_NOTE = { reason: "Left the support rota", by: "ops-night" };

describe.skipIf(TEST_DATABASE_URL === undefined)("platform admin role (database)", () => {
  let db: TestDatabase;
  let ids: Awaited<ReturnType<typeof seedTwoTenants>>;
  let ownerA: string;
  let admin: string;

  beforeAll(async () => {
    db = await createTestDatabase();
    ids = await seedTwoTenants(db.owner);
    ownerA = await addMember(db.owner, ids.orgA, "owner");
    const made = await db.owner.query<{ id: string }>(
      "INSERT INTO staff_user (email, password_hash, platform_role) VALUES ('ops@questify.test', 'h', 'admin') RETURNING id",
    );
    admin = made.rows[0]?.id ?? "";
  });
  afterAll(async () => {
    await db.close();
  });

  const owner = async <T extends Row>(sql: string, values: unknown[] = []) =>
    (await db.owner.query<T>(sql, values)).rows;
  const as = async <T extends Row>(context: RequestContext, sql: string, values: unknown[] = []) =>
    withRequestContext(db.app, context, async () => (await db.app.query<T>(sql, values)).rows);

  it("gives the API role exactly SELECT and UPDATE (password_hash) on staff_user", async () => {
    const table = await owner<{ privilege_type: string }>(
      `SELECT privilege_type FROM information_schema.role_table_grants
       WHERE table_name = 'staff_user' AND grantee = 'questify_app' ORDER BY 1`,
    );
    expect(table.map((row) => row.privilege_type)).toEqual(["SELECT"]);
    const columns = await owner<{ column_name: string }>(
      `SELECT column_name FROM information_schema.column_privileges
       WHERE table_name = 'staff_user' AND grantee = 'questify_app' AND privilege_type = 'UPDATE' ORDER BY 1`,
    );
    expect(columns.map((row) => row.column_name)).toEqual(["password_hash"]);
  });

  it("refuses a platform_role or status write from every API context", async () => {
    const seats: RequestContext[] = [
      { staffUserId: ownerA },
      { isAdmin: true, staffUserId: admin },
      { organizerId: ids.orgA, staffUserId: ownerA },
      { playerId: ids.playerA },
      {},
    ];
    for (const seat of seats) {
      await expect(
        as(seat, "UPDATE staff_user SET platform_role = 'admin' WHERE id = $1", [ownerA]),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        as(seat, "UPDATE staff_user SET status = 'active' WHERE id = $1", [ownerA]),
      ).rejects.toMatchObject({ code: "42501" });
    }
  });

  it("lets a person change only their own password hash, an admin included", async () => {
    const other = await as(
      { isAdmin: true, staffUserId: admin },
      "UPDATE staff_user SET password_hash = 'taken' WHERE id = $1 RETURNING id",
      [ownerA],
    );
    expect(other).toEqual([]);
    const own = await as(
      { staffUserId: ownerA },
      "UPDATE staff_user SET password_hash = 'mine' WHERE id = $1 RETURNING id",
      [ownerA],
    );
    expect(own).toHaveLength(1);
  });

  it("has no API source that writes platform_role or status", async () => {
    const offenders: string[] = [];
    for (const file of await sourceFiles(SRC)) {
      if (file.endsWith(".test.ts") || file.endsWith(join("auth", "staff-admin.ts"))) {
        continue;
      }
      const text = await readFile(file, "utf8");
      if (/UPDATE\s+staff_user\s+SET\s+(platform_role|status)/i.test(text)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("grants and revokes from the owner connection, audited; a revoke ends sessions and support grants", async () => {
    const [made] = await owner<{ id: string }>(
      "INSERT INTO staff_user (email, password_hash) VALUES ('new.ops@questify.test', 'h') RETURNING id",
    );
    const id = made?.id ?? "";
    expect(await setPlatformAdmin(db.owner, "New.Ops@questify.test", true, GRANT_NOTE)).toEqual({
      changed: true,
      sessionsEnded: 0,
      grantsClosed: 0,
    });
    expect(
      await setPlatformAdmin(db.owner, "new.ops@questify.test", true, GRANT_NOTE),
    ).toMatchObject({
      changed: false,
    });
    await owner(
      "INSERT INTO staff_session (staff_user_id, token_hash) VALUES ($1, decode(repeat('ab', 32), 'hex'))",
      [id],
    );
    await as(
      { isAdmin: true, staffUserId: id },
      "SELECT * FROM support_open($1, 'edit', 'Checking a reported quest', NULL)",
      [ids.eventB],
    );
    expect(await setPlatformAdmin(db.owner, "new.ops@questify.test", false, REVOKE_NOTE)).toEqual({
      changed: true,
      sessionsEnded: 1,
      grantsClosed: 1,
    });
    const [state] = await owner<{ role: string; live: number; grants: number }>(
      `SELECT s.platform_role AS role,
              (SELECT count(*)::int FROM staff_session x WHERE x.staff_user_id = s.id AND x.revoked_at IS NULL) AS live,
              (SELECT count(*)::int FROM support_grant g WHERE g.admin_id = s.id AND g.close_kind = 'revoked') AS grants
       FROM staff_user s WHERE s.id = $1`,
      [id],
    );
    expect(state).toEqual({ role: "none", live: 0, grants: 1 });
    const audit = await owner<{ before: unknown; after: unknown }>(
      "SELECT before, after FROM audit_log WHERE action = 'staff.platform_role' AND target_id = $1 ORDER BY id",
      [id],
    );
    expect(audit).toEqual([
      {
        before: { platformRole: "none" },
        after: {
          platformRole: "admin",
          sessionsEnded: 0,
          supportGrantsClosed: 0,
          reason: GRANT_NOTE.reason,
          by: "dhia",
        },
      },
      {
        before: { platformRole: "admin" },
        after: {
          platformRole: "none",
          sessionsEnded: 1,
          supportGrantsClosed: 1,
          reason: REVOKE_NOTE.reason,
          by: "ops-night",
        },
      },
    ]);
    await expect(
      setPlatformAdmin(db.owner, "nobody@questify.test", true, GRANT_NOTE),
    ).rejects.toThrow("No staff account has the email nobody@questify.test.");
  });

  it("refuses a change with no reason, a short or long reason, or no operator, and changes nothing", async () => {
    await owner(
      "INSERT INTO staff_user (email, password_hash) VALUES ('no.note@questify.test', 'h')",
    );
    const attempts = [
      { reason: "", by: "dhia" },
      { reason: "   short  ", by: "dhia" },
      { reason: "x".repeat(301), by: "dhia" },
      { reason: "A reason that is long enough", by: "  " },
    ];
    for (const note of attempts) {
      await expect(setPlatformAdmin(db.owner, "no.note@questify.test", true, note)).rejects.toThrow(
        /reason|operator/,
      );
    }
    const [state] = await owner<{ role: string; audits: number }>(
      `SELECT s.platform_role AS role,
              (SELECT count(*)::int FROM audit_log a WHERE a.target_id = s.id::text) AS audits
       FROM staff_user s WHERE s.email = 'no.note@questify.test'`,
    );
    expect(state).toEqual({ role: "none", audits: 0 });
  });
});

/** FR-1785 (T-709): the last active platform admin cannot be removed, even by two revokes at the same moment. */
describe.skipIf(TEST_DATABASE_URL === undefined)("the last platform admin (database)", () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase();
  });
  afterAll(async () => {
    await db.close();
  });

  const admin = async (email: string, status = "active") => {
    const made = await db.owner.query<{ id: string }>(
      "INSERT INTO staff_user (email, password_hash, platform_role, status) VALUES ($1, 'h', 'admin', $2) RETURNING id",
      [email, status],
    );
    return made.rows[0]?.id ?? "";
  };
  const roleOf = async (email: string) =>
    (
      await db.owner.query<{ platform_role: string }>(
        "SELECT platform_role FROM staff_user WHERE email = $1",
        [email],
      )
    ).rows[0]?.platform_role;

  it("refuses to revoke the only active admin, and changes and audits nothing", async () => {
    await admin("only@questify.test");
    await admin("off@questify.test", "disabled");
    await expect(
      setPlatformAdmin(db.owner, "only@questify.test", false, REVOKE_NOTE),
    ).rejects.toThrow("only@questify.test is the last active platform admin");
    expect(await roleOf("only@questify.test")).toBe("admin");
    const audits = await db.owner.query(
      "SELECT 1 FROM audit_log WHERE action = 'staff.platform_role' AND target_id = (SELECT id::text FROM staff_user WHERE email = 'only@questify.test')",
    );
    expect(audits.rowCount).toBe(0);
  });

  it("revokes a disabled admin, and revokes an admin while another active one remains", async () => {
    expect(await setPlatformAdmin(db.owner, "off@questify.test", false, REVOKE_NOTE)).toMatchObject(
      { changed: true },
    );
    await admin("second@questify.test");
    expect(
      await setPlatformAdmin(db.owner, "second@questify.test", false, REVOKE_NOTE),
    ).toMatchObject({ changed: true });
    expect(await roleOf("only@questify.test")).toBe("admin");
  });

  it("lets only one of two simultaneous revokes through, so an admin is always left", async () => {
    await admin("left@questify.test");
    await admin("right@questify.test");
    await db.owner.query(
      "UPDATE staff_user SET platform_role = 'none' WHERE email = 'only@questify.test'",
    );
    const url = new URL(TEST_DATABASE_URL ?? "");
    url.pathname = new URL(db.appUrl).pathname;
    const second = new Client({ connectionString: url.toString() });
    await second.connect();
    try {
      const results = await Promise.allSettled([
        setPlatformAdmin(db.owner, "left@questify.test", false, REVOKE_NOTE),
        setPlatformAdmin(second, "right@questify.test", false, REVOKE_NOTE),
      ]);
      expect(results.map((result) => result.status).toSorted()).toEqual(["fulfilled", "rejected"]);
    } finally {
      await second.end();
    }
    const left = await db.owner.query(
      "SELECT 1 FROM staff_user WHERE platform_role = 'admin' AND status = 'active'",
    );
    expect(left.rowCount).toBe(1);
  });
});
