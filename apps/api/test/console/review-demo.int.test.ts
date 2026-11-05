import { reviewDemoAnswerSchema, reviewDemoPreparedSchema } from "@questify/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createStaff,
  freshIp,
  signInConsole,
  signInFully,
  startApp,
  withSession,
  type TestApp,
} from "#test/support/auth-app";
import { TEST_DATABASE_URL, createTestDatabase, type TestDatabase } from "#test/support/test-db";

const REVIEWER = "+966500000720";
const ACCEPT = { terms: "0.1", privacy: "0.1" };

/**
 * The App Review demo over HTTP (T-710, FR-1406, FR-1407, FR-1736): the console routes answer 404 to anyone but an
 * active admin; Prepare answers the new fixed code once; the reviewer then signs in on the ordinary player routes with
 * no SMS sent; the fixed code fails for every other number and after Close; the app's account deletion takes it too.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("console review demo over HTTP", () => {
  let db: TestDatabase;
  let test: TestApp;
  let adminCookie = "";
  let ownerCookie = "";
  let code = "";

  beforeAll(async () => {
    db = await createTestDatabase();
    test = await startApp(db);
    await createStaff(db.owner, { email: "admin@questify.test", admin: true });
    await createStaff(db.owner, { email: "owner@najd.test" });
    adminCookie = await signInConsole(test, "admin@questify.test");
    ownerCookie = await signInFully(test, "owner@najd.test");
  });
  afterAll(async () => {
    await test.close();
    await db.close();
  });

  const admin = (
    method: "GET" | "POST" | "PUT",
    url: string,
    payload?: Record<string, unknown>,
    cookie = adminCookie,
  ) =>
    test.app.inject({
      method,
      url,
      headers: withSession(cookie, { "idempotency-key": crypto.randomUUID() }, url),
      ...(payload === undefined ? {} : { payload }),
    });
  const askCode = (phone: string, address = freshIp()) =>
    test.app.inject({
      method: "POST",
      url: "/v1/auth/code",
      headers: { "x-forwarded-for": address },
      payload: { channel: "phone", value: phone, lang: "en", accept: ACCEPT },
    });
  const signIn = async (phone: string, typed: string) => {
    const address = freshIp();
    const asked = await askCode(phone, address);
    expect(asked.statusCode, asked.body).toBe(202);
    return test.app.inject({
      method: "POST",
      url: "/v1/auth/verify",
      headers: { "x-forwarded-for": address },
      payload: {
        challengeToken: asked.json<{ challengeToken: string }>().challengeToken,
        code: typed,
      },
    });
  };

  it("answers 404 to anyone but an admin, before and after Create", async () => {
    for (const [method, url] of [
      ["GET", "/v1/admin/review-demo"],
      ["POST", "/v1/admin/review-demo"],
      ["POST", "/v1/admin/review-demo/prepare"],
      ["POST", "/v1/admin/review-demo/close"],
      ["PUT", "/v1/admin/review-demo/contact"],
    ] as const) {
      expect((await admin(method, url, { phone: REVIEWER }, ownerCookie)).statusCode).toBe(404);
      // No session: refused before any route (401, or 403 for a write without the dashboard's origin).
      expect([401, 403, 404]).toContain((await test.app.inject({ method, url })).statusCode);
    }
  });

  it("creates the demo once and refuses a malformed phone", async () => {
    expect(
      reviewDemoAnswerSchema.parse((await admin("GET", "/v1/admin/review-demo")).json()).demo,
    ).toEqual({ exists: false });
    expect(
      (await admin("PUT", "/v1/admin/review-demo/contact", { phone: REVIEWER })).statusCode,
    ).toBe(404);
    const malformed = await admin("POST", "/v1/admin/review-demo", { phone: "12345" });
    expect(malformed.statusCode).toBe(422);
    expect(malformed.json()).toMatchObject({
      code: "invalid_review_demo",
      details: { field: "phone" },
    });
    const made = await admin("POST", "/v1/admin/review-demo", { phone: "0500000720" });
    expect(made.statusCode, made.body).toBe(201);
    const demo = reviewDemoAnswerSchema.parse(made.json()).demo;
    expect(demo).toMatchObject({ exists: true, contact: REVIEWER, windowUntil: null });
    const again = await admin("POST", "/v1/admin/review-demo", { phone: REVIEWER });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ code: "review_demo_exists" });
  });

  it("shows the new fixed code once, with no-store, and never stores it in clear", async () => {
    expect(
      (await admin("POST", "/v1/admin/review-demo/prepare", { days: 31, version: "1.0" }))
        .statusCode,
    ).toBe(400);
    const prepared = await admin("POST", "/v1/admin/review-demo/prepare", { version: "1.4.0" });
    expect(prepared.statusCode, prepared.body).toBe(200);
    expect(prepared.headers["cache-control"]).toBe("no-store");
    const body = reviewDemoPreparedSchema.parse(prepared.json());
    code = body.code;
    expect(body.demo).toMatchObject({ exists: true, preparedFor: "1.4.0" });
    const audit = await db.owner.query(
      "SELECT after FROM audit_log WHERE action LIKE 'review_demo.%'",
    );
    expect(JSON.stringify(audit.rows)).not.toContain(code);
  });

  it("signs the reviewer in with the fixed code and sends no SMS", async () => {
    const sent = test.sms.sent.length;
    const verified = await signIn(REVIEWER, code);
    expect(verified.statusCode, verified.body).toBe(200);
    expect(verified.json()).toMatchObject({
      player: { username: expect.stringMatching(/^Reviewer[0-9]{4}$/) },
    });
    expect(test.sms.sent.length).toBe(sent);
  });

  it("refuses the fixed code for any other number", async () => {
    const other = await signIn("+966500000721", code);
    expect(other.statusCode).toBe(401);
    expect(other.json()).toMatchObject({ code: "invalid_code" });
  });

  it("deletes the reviewer account from the app with the fixed code, sending nothing", async () => {
    const signedIn = await signIn(REVIEWER, code);
    const token = signedIn.json<{ accessToken: string }>().accessToken;
    const sent = test.sms.sent.length;
    const asked = await test.app.inject({
      method: "POST",
      url: "/v1/me/deletion/code",
      headers: {
        authorization: `Bearer ${token}`,
        "x-forwarded-for": freshIp(),
        "idempotency-key": crypto.randomUUID(),
      },
      payload: { lang: "en" },
    });
    expect(asked.statusCode, asked.body).toBe(202);
    expect(test.sms.sent.length).toBe(sent);
    const verified = await test.app.inject({
      method: "POST",
      url: "/v1/deletion/verify",
      headers: { "x-forwarded-for": freshIp() },
      payload: { challengeToken: asked.json<{ challengeToken: string }>().challengeToken, code },
    });
    expect(verified.statusCode, verified.body).toBe(200);
  });

  it("from the outsider's seat, never signs into a real account that holds the reviewer number", async () => {
    const prepared = await admin("POST", "/v1/admin/review-demo/prepare", { version: "1.4.1" });
    code = reviewDemoPreparedSchema.parse(prepared.json()).code;
    await db.owner.query(
      "UPDATE player_contact SET phone_e164 = NULL, email = 'moved@demo.test' WHERE phone_e164 = $1",
      [REVIEWER],
    );
    const planted = (
      await db.owner.query<{ id: string }>(
        `WITH p AS (INSERT INTO player (username) VALUES ('planted_real') RETURNING id)
         INSERT INTO player_contact (player_id, phone_e164) SELECT id, $1 FROM p RETURNING player_id AS id`,
        [REVIEWER],
      )
    ).rows[0]?.id;
    const tried = await signIn(REVIEWER, code);
    expect(tried.statusCode).not.toBe(200);
    const sessions = await db.owner.query("SELECT 1 FROM player_session WHERE player_id = $1", [
      planted,
    ]);
    expect(sessions.rows).toEqual([]);
    const refused = await admin("POST", "/v1/admin/review-demo/prepare", { version: "1.4.2" });
    expect(refused.json()).toMatchObject({ code: "contact_held" });
    await db.owner.query("DELETE FROM player_contact WHERE player_id = $1", [planted]);
    await db.owner.query(
      "UPDATE player_contact SET phone_e164 = $1, email = NULL WHERE email = 'moved@demo.test'",
      [REVIEWER],
    );
  });

  it("stops the fixed code at Close; the reviewer number then gets a real SMS", async () => {
    expect((await admin("POST", "/v1/admin/review-demo/close", {})).statusCode).toBe(200);
    const sent = test.sms.sent.length;
    const after = await signIn(REVIEWER, code);
    expect(after.statusCode).toBe(401);
    expect(test.sms.sent.length).toBe(sent + 1);
  });

  it("changes the reviewer number and shows the new one", async () => {
    const changed = await admin("PUT", "/v1/admin/review-demo/contact", { phone: "0500000722" });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(reviewDemoAnswerSchema.parse(changed.json()).demo).toMatchObject({
      exists: true,
      contact: "+966500000722",
      windowUntil: null,
    });
  });
});
