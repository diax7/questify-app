import { randomUUID } from "node:crypto";
import { dataEraseAnswerSchema } from "@questify/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAuthKeys } from "#src/auth/keys";
import { BUCKETS } from "#src/auth/throttle";
import {
  createStaff,
  signInFully,
  startApp,
  withSession,
  type TestApp,
} from "#test/support/auth-app";
import { TEST_DATABASE_URL, createTestDatabase, type TestDatabase } from "#test/support/test-db";

type Row = Record<string, unknown>;
type Method = "GET" | "POST";

const CASE = { reasonCode: "legal_request", reference: "LEGAL-2026/14" };

/**
 * The console's legal data requests over HTTP (T-708, FR-1778): 404 to everyone but a platform admin; the export is a
 * download nothing keeps and needs no Idempotency-Key; the erase needs one, the username typed and a forfeit for
 * pending handovers; the case is checked first; the per-admin limits answer 429 with Retry-After; no contact reaches a
 * log line.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("console data requests over HTTP", () => {
  let db: TestDatabase;
  let test: TestApp;
  let adminId = "";
  let adminCookie = "";
  let memberCookie = "";
  let serial = 0;
  const lines: string[] = [];
  const keys = createAuthKeys("t".repeat(40));

  const owner = async <T extends Row>(sql: string, values: unknown[] = []) =>
    (await db.owner.query<T>(sql, values)).rows;
  const newPlayer = async () => {
    serial += 1;
    const username = `legal_${serial}`;
    const email = `legal${serial}@example.com`;
    const [made] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [username],
    );
    await owner("INSERT INTO player_contact (player_id, email) VALUES ($1, $2)", [made?.id, email]);
    return { id: made?.id ?? "", username, email };
  };
  const call = (
    method: Method,
    url: string,
    cookie: string,
    payload?: object,
    key: string | null = randomUUID(),
  ) =>
    test.app.inject({
      method,
      url,
      headers: withSession(cookie, key === null ? {} : { "idempotency-key": key }),
      ...(payload === undefined ? {} : { payload }),
    });

  beforeAll(async () => {
    db = await createTestDatabase();
    test = await startApp(db, {
      level: "info",
      stream: { write: (line: string) => void lines.push(line) },
    });
    adminId = await createStaff(db.owner, { email: "legal@questify.test", admin: true });
    await createStaff(db.owner, { email: "owner@najd.test" });
    adminCookie = await signInFully(test, "legal@questify.test");
    memberCookie = await signInFully(test, "owner@najd.test");
  });
  afterAll(async () => {
    await test.close();
    await db.close();
  });

  it("answers 404 to a member and 401 or 403 to nobody signed in, on every route", async () => {
    const p = await newPlayer();
    const routes: [Method, string, object?][] = [
      ["POST", `/v1/admin/players/${p.id}/data-export`, CASE],
      ["GET", `/v1/admin/players/${p.id}/pending`],
      ["POST", `/v1/admin/players/${p.id}/erase`, { ...CASE, username: p.username }],
    ];
    for (const [method, url, payload] of routes) {
      expect((await call(method, url, memberCookie, payload)).statusCode, url).toBe(404);
      expect([401, 403], url).toContain((await call(method, url, "", payload)).statusCode);
    }
    expect(
      await owner("SELECT 1 FROM player WHERE id = $1 AND status = 'active'", [p.id]),
    ).toHaveLength(1);
  });

  it("exports as a download with no Idempotency-Key, after checking the case", async () => {
    const p = await newPlayer();
    const url = `/v1/admin/players/${p.id}/data-export`;
    const bad = await call("POST", url, adminCookie, { ...CASE, reference: "966551234567" }, null);
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ code: "invalid_request", details: { field: "reference" } });
    expect(
      (await call("POST", url, adminCookie, { ...CASE, reasonCode: "curious" }, null)).json(),
    ).toMatchObject({
      details: { field: "reasonCode" },
    });
    const answer = await call("POST", url, adminCookie, CASE, null);
    expect(answer.statusCode).toBe(200);
    expect(answer.headers["cache-control"]).toBe("no-store");
    expect(answer.headers["content-disposition"]).toMatch(/^attachment; filename="questify-data-/);
    expect(answer.json()).toMatchObject({ playerId: p.id, contacts: { email: p.email } });
    expect(
      (await call("POST", `/v1/admin/players/${randomUUID()}/data-export`, adminCookie, CASE, null))
        .statusCode,
    ).toBe(404);
    expect(lines.join("\n")).not.toContain(p.email);
  });

  it("erases with the username typed, the forfeit and an Idempotency-Key, and forgets the player's answers", async () => {
    const p = await newPlayer();
    const url = `/v1/admin/players/${p.id}/erase`;
    expect(
      (await call("POST", url, adminCookie, { ...CASE, username: p.username }, null)).statusCode,
    ).toBe(400);
    const wrong = await call("POST", url, adminCookie, {
      ...CASE,
      username: p.username.toUpperCase(),
    });
    expect(wrong.statusCode).toBe(409);
    expect(wrong.json()).toMatchObject({ code: "confirmation_required" });
    expect((await call("GET", `/v1/admin/players/${p.id}/pending`, adminCookie)).json()).toEqual({
      pending: [],
    });
    const key = randomUUID();
    const erased = await call("POST", url, adminCookie, { ...CASE, username: p.username }, key);
    expect(erased.statusCode).toBe(200);
    expect(dataEraseAnswerSchema.parse(erased.json())).toEqual({ outcome: "erased", events: [] });
    const again = await call("POST", url, adminCookie, { ...CASE, username: p.username });
    expect(again.json()).toEqual({ outcome: "already_deleted", events: [] });
    expect(
      lines.some((line) => line.includes('"event":"player.deleted"') && line.includes(p.id)),
    ).toBe(true);
    expect(lines.join("\n")).not.toContain(p.email);
    const record = await call("GET", `/v1/admin/players/${p.id}`, adminCookie);
    expect(record.json()).toMatchObject({ player: { status: "deleted" } });
    expect((record.json() as { legalRequests: unknown[] }).legalRequests).toHaveLength(1);
  });

  it("holds each admin to 10 exports an hour", async () => {
    const p = await newPlayer();
    const key = keys.userKey(`${BUCKETS.consoleDataExport}:${adminId}`);
    await owner(
      "INSERT INTO auth_throttle (bucket, key) SELECT $1, $2 FROM generate_series(1, 10)",
      [BUCKETS.consoleDataExport, key],
    );
    const refused = await call(
      "POST",
      `/v1/admin/players/${p.id}/data-export`,
      adminCookie,
      CASE,
      null,
    );
    expect(refused.statusCode).toBe(429);
    expect(Number(refused.headers["retry-after"])).toBeGreaterThan(0);
  });
});
