import { createHash, randomBytes, randomUUID } from "node:crypto";
import { joinCard } from "@questify/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createStaff,
  freshIp,
  signInFully,
  startApp,
  withSession,
  type TestApp,
} from "#test/support/auth-app";
import { TEST_DATABASE_URL, createTestDatabase, type TestDatabase } from "#test/support/test-db";

type Code = { kind: string; id: string; questId: string | null; url: string | null };

/**
 * The App Review demo's QR picker over HTTP (T-710b, FR-303's review half, FR-1407, ADR-565, ADR-640): Home flags the
 * reviewer in the demo event; the picker lists signed codes that the ordinary scan routes accept; a fictional player's
 * meet code pays through POST /v1/meet. From the outsider's seat, a real player, another event, no session and a closed
 * window all get the 404 an unknown event gets, and Home carries no flag.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("review demo QR picker over HTTP", () => {
  let db: TestDatabase;
  let test: TestApp;
  let adminCookie = "";
  let reviewer = "";
  let event = "";
  let joinCode = "";
  let token = "";
  let counter = 0;
  const quests: Record<string, string> = {};

  const sessionFor = async (player: string): Promise<string> => {
    const made = randomBytes(32).toString("base64url");
    await db.owner.query(
      "INSERT INTO player_session (player_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
      [player, createHash("sha256").update(made).digest()],
    );
    return made;
  };
  const admin = (url: string, payload: Record<string, unknown>) =>
    test.app.inject({
      method: "POST",
      url,
      headers: withSession(adminCookie, { "idempotency-key": randomUUID() }),
      payload,
    });
  const as = (
    bearer: string,
    method: "GET" | "POST",
    url: string,
    payload?: Record<string, unknown>,
  ) =>
    test.app.inject({
      method,
      url,
      headers: {
        authorization: `Bearer ${bearer}`,
        "x-forwarded-for": freshIp(),
        "idempotency-key": randomUUID(),
      },
      ...(payload === undefined ? {} : { payload }),
    });
  const join = (bearer: string, code: string) =>
    as(bearer, "POST", "/v1/join", {
      joinCode: code,
      via: "code",
      cardVersion: joinCard().version,
    });
  const quest = async (category: string, type: string, config: object) => {
    const { rows } = await db.owner.query<{ id: string }>(
      `INSERT INTO quest (event_id, category_id, type, title_en, title_ar, points, repeat_cap, type_config, verification)
       VALUES ($1, $2, $3, 'Gate', 'البوابة', 10, 5, $4, $5) RETURNING id`,
      [event, category, type, JSON.stringify(config), type === "meet" ? [] : ["quest_qr"]],
    );
    return rows[0]?.id ?? "";
  };
  const realPlayer = async () => {
    counter += 1;
    const { rows } = await db.owner.query<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`rdc_real_${counter}`],
    );
    return sessionFor(rows[0]?.id ?? "");
  };

  beforeAll(async () => {
    db = await createTestDatabase();
    test = await startApp(db);
    await createStaff(db.owner, { email: "admin@questify.test", admin: true });
    adminCookie = await signInFully(test, "admin@questify.test");
    expect((await admin("/v1/admin/review-demo", { phone: "+966500000730" })).statusCode).toBe(201);
    expect((await admin("/v1/admin/review-demo/prepare", { version: "1.5.0" })).statusCode).toBe(
      200,
    );
    const { rows } = await db.owner.query<{
      player_id: string;
      event_id: string;
      join_code: string;
    }>(
      "SELECT d.player_id, d.event_id, e.join_code FROM review_demo d JOIN event e ON e.id = d.event_id",
    );
    reviewer = rows[0]?.player_id ?? "";
    event = rows[0]?.event_id ?? "";
    joinCode = rows[0]?.join_code ?? "";
    token = await sessionFor(reviewer);
    expect((await join(token, joinCode)).statusCode).toBeLessThan(300);
    const category = await db.owner.query<{ id: string }>(
      "INSERT INTO category (event_id, name_en, name_ar) VALUES ($1, 'Booths', 'الأجنحة') RETURNING id",
      [event],
    );
    quests["qr"] = await quest(category.rows[0]?.id ?? "", "scan_qr", {});
    quests["meet"] = await quest(category.rows[0]?.id ?? "", "meet", { dailyCap: 5 });
  });
  afterAll(async () => {
    await test.close();
    await db.close();
  });

  it("flags Home for the reviewer and lists signed codes the ordinary scan route pays", async () => {
    const home = await as(token, "GET", `/v1/events/${event}/home`);
    expect(home.statusCode, home.body).toBe(200);
    expect(home.json()).toMatchObject({ reviewDemo: true });
    const listed = await as(token, "GET", `/v1/events/${event}/review-codes`);
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.headers["cache-control"]).toBe("no-store");
    const codes = listed.json<{ codes: Code[] }>().codes;
    expect(codes.map((code) => `${code.kind}:${code.id}`).toSorted()).toEqual(
      [`quest:${quests["qr"]}`, `meet:${quests["meet"]}`].toSorted(),
    );
    const qr = codes.find((code) => code.kind === "quest");
    expect(qr?.url).toMatch(/\/q\/[A-Za-z0-9_-]{50}$/);
    expect(codes.find((code) => code.kind === "meet")?.url).toBeNull();
    const scanned = await as(token, "POST", `/v1/quests/${quests["qr"]}/complete`, {
      proof: { type: "qr", code: qr?.url?.split("/").at(-1) },
    });
    expect(scanned.statusCode, scanned.body).toBe(200);
    expect(scanned.json()).toMatchObject({ points: 10 });
  });

  it("issues a fictional player's meet code that POST /v1/meet pays", async () => {
    const pass = await as(token, "POST", `/v1/events/${event}/review-codes/meet`, {
      questId: quests["meet"],
    });
    expect(pass.statusCode, pass.body).toBe(201);
    const { code } = pass.json<{ code: string; expiresAt: string }>();
    expect(code).toMatch(/^questify\/meet\/v1\//);
    const met = await as(token, "POST", "/v1/meet", { code });
    expect(met.statusCode, met.body).toBe(200);
    expect(met.json()).toMatchObject({ points: 10 });
    const wrong = await as(token, "POST", `/v1/events/${event}/review-codes/meet`, {
      questId: quests["qr"],
    });
    expect(wrong.statusCode).toBe(404);
    const malformed = await as(token, "POST", `/v1/events/${event}/review-codes/meet`, {
      questId: quests["meet"],
      extra: 1,
    });
    expect(malformed.statusCode).toBe(400);
  });

  it("from the outsider's seat, answers 404 to a real player, another event and no flag on their Home", async () => {
    const real = await realPlayer();
    expect((await as(real, "GET", `/v1/events/${event}/review-codes`)).statusCode).toBe(404);
    expect(
      (await as(real, "POST", `/v1/events/${event}/review-codes/meet`, { questId: quests["meet"] }))
        .statusCode,
    ).toBe(404);
    const { rows } = await db.owner.query<{ id: string; join_code: string }>(
      `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at)
       SELECT organizer_id, 'RDCOTHER', 'Other', 'live', now() - interval '1 hour', now() + interval '1 day'
       FROM event WHERE id = $1 RETURNING id, join_code`,
      [event],
    );
    const other = rows[0]?.id ?? "";
    expect((await as(token, "GET", `/v1/events/${other}/review-codes`)).statusCode).toBe(404);
    expect((await as(token, "GET", `/v1/events/${randomUUID()}/review-codes`)).statusCode).toBe(
      404,
    );
    const anonymous = await test.app.inject({
      method: "GET",
      url: `/v1/events/${event}/review-codes`,
    });
    expect(anonymous.statusCode).toBe(401);
  });

  it("answers 404 once the window closes, even to a fresh reviewer session, and drops the Home flag", async () => {
    expect((await admin("/v1/admin/review-demo/close", {})).statusCode).toBe(200);
    const fresh = await sessionFor(reviewer);
    expect((await as(fresh, "GET", `/v1/events/${event}/review-codes`)).statusCode).toBe(404);
    const home = await as(fresh, "GET", `/v1/events/${event}/home`);
    expect(home.statusCode, home.body).toBe(200);
    expect(home.json()).not.toHaveProperty("reviewDemo");
  });
});
