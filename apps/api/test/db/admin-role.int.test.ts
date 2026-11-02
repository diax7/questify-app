import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
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
    expect(await setPlatformAdmin(db.owner, "New.Ops@questify.test", true)).toEqual({
      changed: true,
      sessionsEnded: 0,
      grantsClosed: 0,
    });
    expect(await setPlatformAdmin(db.owner, "new.ops@questify.test", true)).toMatchObject({
      changed: false,
    });
    await owner(
      "INSERT INTO staff_session (staff_user_id, token_hash) VALUES ($1, decode(repeat('ab', 32), 'hex'))",
      [id],
    );
    await as(
      { isAdmin: true, staffUserId: id },
      "SELECT * FROM support_open($1, 'Checking a reported quest', NULL)",
      [ids.eventB],
    );
    expect(await setPlatformAdmin(db.owner, "new.ops@questify.test", false)).toEqual({
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
        after: { platformRole: "admin", sessionsEnded: 0, supportGrantsClosed: 0 },
      },
      {
        before: { platformRole: "admin" },
        after: { platformRole: "none", sessionsEnded: 1, supportGrantsClosed: 1 },
      },
    ]);
    await expect(setPlatformAdmin(db.owner, "nobody@questify.test", true)).rejects.toThrow(
      "No staff account has the email nobody@questify.test.",
    );
  });
});
