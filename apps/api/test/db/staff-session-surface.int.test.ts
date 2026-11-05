import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withPreIdentityContext } from "#src/db/pre-identity";
import { TEST_DATABASE_URL, createTestDatabase, type TestDatabase } from "#test/support/test-db";

const refusal = (work: Promise<unknown>) =>
  work.then(
    () => "none",
    (error: { code?: string }) => String(error.code),
  );

/**
 * A staff session's surface (T-810d, migration 0156, ADR-720): `dashboard` or `console`, set only by
 * open_staff_session, never changed by the API role, and one session cap across both.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("staff session surface (database)", () => {
  let db: TestDatabase;
  let sara = "";

  beforeAll(async () => {
    db = await createTestDatabase();
    const { rows } = await db.owner.query<{ id: string }>(
      "INSERT INTO staff_user (email, password_hash) VALUES ('sara@surface.test', 'x') RETURNING id",
    );
    sara = rows[0]?.id ?? "";
  });
  afterAll(async () => {
    await db.close();
  });

  const asSara = <T>(sql: string, values: unknown[] = []) =>
    withPreIdentityContext(
      db.app,
      { kind: "email", email: "sara@surface.test" },
      async ({ promote }) => {
        await promote(sara);
        return (await db.app.query(sql, values)).rows as T[];
      },
    );
  const open = (surface: string | null) =>
    asSara<{ session_id: string; ended: number }>(
      "SELECT session_id, ended FROM open_staff_session($1, 'agent', '198.51.100.1', $2)",
      [randomBytes(32), surface],
    );
  const surfaceOf = async (id: string | undefined) =>
    (
      await db.owner.query<{ surface: string }>("SELECT surface FROM staff_session WHERE id = $1", [
        id,
      ])
    ).rows[0]?.surface;

  it("makes an existing or owner-written row a dashboard session", async () => {
    const { rows } = await db.owner.query<{ surface: string }>(
      "INSERT INTO staff_session (staff_user_id, token_hash) VALUES ($1, $2) RETURNING surface",
      [sara, randomBytes(32)],
    );
    expect(rows[0]?.surface).toBe("dashboard");
  });

  it("refuses any other value in the column", async () => {
    expect(
      await refusal(
        db.owner.query(
          "INSERT INTO staff_session (staff_user_id, token_hash, surface) VALUES ($1, $2, 'admin')",
          [sara, randomBytes(32)],
        ),
      ),
    ).toBe("23514");
  });

  it("stores each surface through the definer and refuses a third with 22023 before writing", async () => {
    const [consoleRow] = await open("console");
    const [dashboardRow] = await open("dashboard");
    expect(await surfaceOf(consoleRow?.session_id)).toBe("console");
    expect(await surfaceOf(dashboardRow?.session_id)).toBe("dashboard");
    const before = await db.owner.query("SELECT 1 FROM staff_session WHERE staff_user_id = $1", [
      sara,
    ]);
    expect(await refusal(open("admin"))).toBe("22023");
    expect(await refusal(open(null))).toBe("22023");
    const after = await db.owner.query("SELECT 1 FROM staff_session WHERE staff_user_id = $1", [
      sara,
    ]);
    expect(after.rowCount).toBe(before.rowCount);
  });

  it("counts both surfaces in the one cap of 10 live sessions", async () => {
    await db.owner.query("DELETE FROM staff_session WHERE staff_user_id = $1", [sara]);
    for (let n = 0; n < 5; n += 1) {
      await open("console");
      await open("dashboard");
    }
    const [eleventh] = await open("console");
    expect(eleventh?.ended).toBe(1);
    const live = await db.owner.query<{ n: string }>(
      "SELECT count(*) AS n FROM staff_session WHERE staff_user_id = $1 AND revoked_at IS NULL",
      [sara],
    );
    expect(Number(live.rows[0]?.n)).toBe(10);
  });

  it("never lets the API role set or change the surface itself", async () => {
    expect(
      await refusal(
        asSara("UPDATE staff_session SET surface = 'console' WHERE staff_user_id = $1", [sara]),
      ),
    ).toBe("42501");
    expect(
      await refusal(
        asSara(
          "INSERT INTO staff_session (staff_user_id, token_hash, surface) VALUES ($1, $2, 'console')",
          [sara, randomBytes(32)],
        ),
      ),
    ).toBe("42501");
  });

  it("keeps the old three-argument opener gone and the new one closed to the public", async () => {
    const { rows } = await db.owner.query<{ signature: string; public: boolean; app: boolean }>(
      `SELECT p.oid::regprocedure::text AS signature,
              has_function_privilege('public', p.oid, 'EXECUTE') AS public,
              has_function_privilege('questify_app', p.oid, 'EXECUTE') AS app
       FROM pg_proc p WHERE p.proname = 'open_staff_session'`,
    );
    expect(rows).toEqual([
      { signature: "open_staff_session(bytea,text,text,text)", public: false, app: true },
    ]);
    expect(
      await refusal(
        db.outsider.query("SELECT public.open_staff_session($1::bytea, 'a', 'b', 'console')", [
          randomBytes(32),
        ]),
      ),
    ).toBe("42501");
  });
});
