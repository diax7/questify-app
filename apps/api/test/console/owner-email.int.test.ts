import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PASSWORD,
  browserHeaders,
  createStaff,
  postPassword,
  signInFully,
  startApp,
  withSession,
  type TestApp,
} from "#test/support/auth-app";
import { TEST_DATABASE_URL, createTestDatabase, type TestDatabase } from "#test/support/test-db";

const REASON = "Owner called back on the number on file.";
const tokenIn = (text: string | undefined, page: string): string => {
  const found = new RegExp(`/${page}#token=([A-Za-z0-9_-]{43})`).exec(text ?? "")?.[1];
  if (found === undefined) throw new Error(`No ${page} link in the email.`);
  return found;
};

/**
 * The owner email change over HTTP (T-701b, ADR-490..492): the console's start, resend and cancel; the public confirm
 * with the code and the current password (or a 24-hour hold without it); the old address's Stop; the emails to both
 * addresses; the per-address limit; and the moderation addresses card.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("owner email change over HTTP", () => {
  let db: TestDatabase;
  let test: TestApp;
  let adminCookie: string;
  let strangerCookie: string;
  let count = 0;

  const owner = async <T extends Record<string, unknown>>(sql: string, values: unknown[] = []) =>
    (await db.owner.query<T>(sql, values)).rows;

  beforeAll(async () => {
    db = await createTestDatabase();
    test = await startApp(db);
    await createStaff(db.owner, { email: "admin@questify.test", admin: true });
    await createStaff(db.owner, { email: "stranger@najd.test" });
    adminCookie = await signInFully(test, "admin@questify.test");
    strangerCookie = await signInFully(test, "stranger@najd.test");
  }, 180_000);
  afterAll(async () => {
    await test.close();
    await db.close();
  });

  const newOwner = async () => {
    count += 1;
    const email = `owner${count}@najd.test`;
    const [org] = await owner<{ id: string }>(
      "INSERT INTO organizer (name, slug) VALUES ($1, $2) RETURNING id",
      [`Najd ${count}`, `najd-${count}`],
    );
    const id = await createStaff(db.owner, { email });
    await owner(
      "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, 'owner')",
      [org?.id, id],
    );
    return { org: org?.id ?? "", email, id };
  };
  const admin = (url: string, payload?: object, cookie = adminCookie) =>
    test.app.inject({
      method: "POST",
      url,
      headers: withSession(cookie, { "idempotency-key": randomUUID() }),
      ...(payload === undefined ? {} : { payload }),
    });
  const start = (org: string, newEmail: string, cookie = adminCookie) =>
    admin(
      `/v1/admin/organizers/${org}/owner-email`,
      { newEmail, identityCheck: "known_phone", reason: REASON, lang: "en" },
      cookie,
    );
  const open = (path: string, payload: object, headers = browserHeaders()) =>
    test.app.inject({
      method: "POST",
      url: `/v1/staff/auth/email-change/${path}`,
      headers,
      payload,
    });
  const begin = async () => {
    const who = await newOwner();
    const newEmail = `fresh${count}@mail.test`;
    const started = await start(who.org, newEmail);
    expect(started.statusCode, started.body).toBe(201);
    const codeMail = test.mail.to(newEmail).at(-1);
    const notice = test.mail.to(who.email).at(-1);
    return {
      ...who,
      newEmail,
      changeId: started.json<{ changeId: string }>().changeId,
      token: tokenIn(codeMail?.text, "email-change"),
      stop: tokenIn(notice?.text, "email-change/stop"),
      code: test.mail.lastCode(newEmail),
      notice,
    };
  };

  it("answers 404 to anyone but an admin, and refuses the admin's own organizer seat", async () => {
    const who = await newOwner();
    expect((await start(who.org, "x@mail.test", strangerCookie)).statusCode).toBe(404);
    const anonymous = await test.app.inject({
      method: "POST",
      url: `/v1/admin/organizers/${who.org}/owner-email`,
      headers: browserHeaders({ "idempotency-key": randomUUID() }),
      payload: { newEmail: "x@mail.test", identityCheck: "other", reason: REASON },
    });
    expect([401, 404]).toContain(anonymous.statusCode);
    expect((await start(randomUUID(), "x@mail.test")).statusCode).toBe(404);
    expect((await start(who.org, who.email)).json<{ code: string }>().code).toBe("same_email");
    expect((await start(who.org, "admin@questify.test")).json<{ code: string }>().code).toBe(
      "email_taken",
    );
  });

  it("mails the code to the new address and a masked notice with Stop to the old one", async () => {
    const c = await begin();
    expect(c.notice?.text).toContain("f•••@m•••.test");
    expect(c.notice?.text).not.toContain(c.newEmail);
    const view = await open("view", { token: c.token });
    expect(view.json()).toEqual({
      organizerName: expect.stringMatching(/^Najd /),
      newEmailMasked: "f•••@m•••.test",
      expiresAt: expect.any(String),
    });
    expect(view.headers["cache-control"]).toBe("no-store");
  });

  it("confirms with the code and the password: signs out everywhere, the new address signs in", async () => {
    const c = await begin();
    const ownerCookie = await signInFully(test, c.email);
    const wrong = await open("confirm", {
      token: c.token,
      code: c.code,
      password: "not it at all",
    });
    expect(wrong.statusCode).toBe(422);
    expect(wrong.json()).toMatchObject({
      code: "wrong_code_or_password",
      details: { attemptsLeft: 4 },
    });
    const done = await open("confirm", { token: c.token, code: c.code, password: PASSWORD });
    expect(done.json()).toEqual({ outcome: "confirmed", email: c.newEmail });
    const me = await test.app.inject({
      method: "GET",
      url: "/v1/staff/me",
      headers: withSession(ownerCookie),
    });
    expect(me.statusCode).toBe(401);
    expect((await postPassword(test, c.newEmail)).statusCode).toBe(200);
    expect((await postPassword(test, c.email)).statusCode).toBe(401);
    const texts = (to: string) => test.mail.to(to).map((mail) => mail.text);
    expect(texts(c.newEmail).some((text) => text.includes("sign-in email is now"))).toBe(true);
    expect(texts(c.email).some((text) => text.includes("signed out everywhere"))).toBe(true);
    const stop = await open("stop", { token: c.stop });
    expect(stop.json()).toEqual({ outcome: "reported" });
    expect(
      await owner("SELECT kind FROM team_alert WHERE change_id = $1", [c.changeId]),
    ).toHaveLength(1);
  });

  it("holds the change 24 hours without the password, and the old address stops it", async () => {
    const c = await begin();
    const held = await open("confirm", { token: c.token, code: c.code, password: null });
    expect(held.json()).toMatchObject({ outcome: "held", appliesAt: expect.any(String) });
    expect(test.mail.to(c.email).at(-1)?.text).toContain("will change to");
    expect((await open("stop", { token: c.stop })).json()).toEqual({ outcome: "stopped" });
    expect((await postPassword(test, c.email)).statusCode).toBe(200);
  });

  it("closes the change and answers 502 when the code email cannot be sent", async () => {
    const who = await newOwner();
    test.mail.failing = true;
    try {
      const failed = await start(who.org, `lost${count}@mail.test`);
      expect(failed.statusCode).toBe(502);
      expect(failed.json<{ code: string }>().code).toBe("code_not_sent");
    } finally {
      test.mail.failing = false;
    }
    const [row] = await owner<{ state: string }>(
      "SELECT state FROM staff_email_change WHERE organizer_id = $1",
      [who.org],
    );
    expect(row?.state).toBe("send_failed");
  });

  it("resends a minute apart, cancels once, and shows the change on the organizer page", async () => {
    const c = await begin();
    const soon = await admin(`/v1/admin/owner-email-changes/${c.changeId}/resend`, { lang: "en" });
    expect(soon.json<{ code: string }>().code).toBe("resend_too_soon");
    await owner(
      "UPDATE staff_email_change SET last_sent_at = now() - interval '2 minutes' WHERE id = $1",
      [c.changeId],
    );
    const resent = await admin(`/v1/admin/owner-email-changes/${c.changeId}/resend`, {
      lang: "en",
    });
    expect(resent.statusCode).toBe(204);
    expect(tokenIn(test.mail.to(c.newEmail).at(-1)?.text, "email-change")).toBe(c.token);
    const page = await test.app.inject({
      method: "GET",
      url: `/v1/admin/organizers/${c.org}`,
      headers: withSession(adminCookie),
    });
    expect(page.json()).toMatchObject({
      ownerEmailChange: { id: c.changeId, state: "pending", resends: 1, newEmail: c.newEmail },
    });
    expect((await admin(`/v1/admin/owner-email-changes/${c.changeId}/cancel`)).statusCode).toBe(
      204,
    );
    const again = await admin(`/v1/admin/owner-email-changes/${c.changeId}/cancel`);
    expect(again.json<{ code: string }>().code).toBe("email_change_closed");
  });

  it("limits the public routes to 20 calls per address in 15 minutes", async () => {
    const headers = browserHeaders();
    for (let call = 0; call < 20; call += 1) {
      expect((await open("view", { token: "a".repeat(43) }, headers)).statusCode).toBe(404);
    }
    const limited = await open("view", { token: "a".repeat(43) }, headers);
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("reads and saves the moderation addresses, falling back to the sending address", async () => {
    const read = () =>
      test.app.inject({
        method: "GET",
        url: "/v1/admin/moderation-addresses",
        headers: withSession(adminCookie),
      });
    expect((await read()).json()).toEqual({
      alertEmail: null,
      appealEmail: null,
      sendingAddress: expect.any(String),
    });
    const put = (payload: object) =>
      test.app.inject({
        method: "PUT",
        url: "/v1/admin/moderation-addresses",
        headers: withSession(adminCookie, { "idempotency-key": randomUUID() }),
        payload,
      });
    expect((await put({ alertEmail: "nope", appealEmail: null })).statusCode).toBe(422);
    const saved = await put({ alertEmail: "alerts@questify.test", appealEmail: null });
    expect(saved.json()).toMatchObject({ alertEmail: "alerts@questify.test", appealEmail: null });
    const stranger = await test.app.inject({
      method: "GET",
      url: "/v1/admin/moderation-addresses",
      headers: withSession(strangerCookie),
    });
    expect(stranger.statusCode).toBe(404);
  });
});
