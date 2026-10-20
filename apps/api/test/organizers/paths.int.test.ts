import { createHash, randomUUID } from "node:crypto";
import type { LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loggerOptions } from "#src/app";
import { createAuthKeys } from "#src/auth/keys";
import { takeOutboundMail } from "#src/auth/outbound";
import type * as GateModule from "#src/auth/verify-gate";
import type * as NamingModule from "#src/organizers/naming";
import { BUCKETS } from "#src/auth/throttle";
import {
  browserHeaders,
  createStaff,
  freshIp,
  postCode,
  sessionCookieOf,
  signInFully,
  startApp,
  testConfig,
  withSession,
  type TestApp,
} from "#test/support/auth-app";
import { TEST_DATABASE_URL, createTestDatabase, type TestDatabase } from "#test/support/test-db";

/**
 * T-101's rarer paths, with the log lines they leave: held locks, the mail budget at its edge, resends, slug collisions,
 * failed sends, every refusal of an invite. Complements sign-up.int.test.ts and team.int.test.ts.
 */
const control = vi.hoisted(() => ({ slugs: [] as string[], gateBusyOnCall: 0, gateCalls: 0 }));

vi.mock("#src/organizers/naming", async (importOriginal) => {
  const actual = await importOriginal<typeof NamingModule>();
  return { ...actual, slugFor: (name: string) => control.slugs.shift() ?? actual.slugFor(name) };
});

vi.mock("#src/auth/verify-gate", async (importOriginal) => {
  const actual = await importOriginal<typeof GateModule>();
  return {
    ...actual,
    createVerifyGate: (options: { limit: number; waitMs: number }) => {
      const gate = actual.createVerifyGate(options);
      return {
        run: <T>(work: () => Promise<T>): Promise<T> => {
          control.gateCalls += 1;
          if (control.gateBusyOnCall !== 0 && control.gateCalls === control.gateBusyOnCall) {
            return Promise.reject(new actual.GateBusyError());
          }
          return gate.run(work);
        },
      };
    },
  };
});

const PASSWORD = "a long and new pass phrase";
const ACCEPT = { terms: "0.1", dpa: "0.1", contentRules: "0.1" };
const OUTBOUND_KEY = createHash("sha256").update("questify.outbound_mail").digest();
const keys = createAuthKeys(testConfig().auth.secret);
const lockKey = (key: Buffer): string => key.readBigInt64BE(0).toString();

type Line = Readonly<Record<string, unknown>>;

const tokenOf = (response: LightMyRequestResponse): string =>
  response.json<{ challengeToken: string }>().challengeToken;

describe.skipIf(TEST_DATABASE_URL === undefined)("T-101 rarer paths", () => {
  let db: TestDatabase;
  let test: TestApp;
  let lines: string[] = [];
  let counter = 0;
  const newEmail = (who = "path"): string => {
    counter += 1;
    return `${who}${counter}@paths.test`;
  };

  beforeAll(async () => {
    db = await createTestDatabase();
    test = await startApp(db, {
      ...loggerOptions(testConfig()),
      level: "info",
      stream: { write: (line: string) => void lines.push(line) },
    });
  });
  afterAll(async () => {
    await test.close();
    await db.close();
  });
  beforeEach(async () => {
    lines = [];
    control.slugs = [];
    control.gateBusyOnCall = 0;
    control.gateCalls = 0;
    await db.owner.query("DELETE FROM auth_throttle WHERE bucket = 'outbound_mail'");
  });

  const events = (name: string): Line[] =>
    lines
      .map((line) => JSON.parse(line) as Line)
      .filter((line) => line["event"] === name)
      .map(
        ({ event: _e, level: _l, time: _t, pid: _p, hostname: _h, reqId: _r, addr: _a, ...rest }) =>
          rest,
      );
  const owner = <T extends Record<string, unknown>>(sql: string, values: unknown[] = []) =>
    db.owner.query<T>(sql, values).then((result) => result.rows);
  /** Holds an advisory lock in its own transaction while `work` runs, as a concurrent request would. */
  const whileLocked = async <T>(key: Buffer, work: () => Promise<T>): Promise<T> => {
    await db.owner.query("BEGIN");
    try {
      await db.owner.query("SELECT pg_advisory_xact_lock($1::bigint)", [lockKey(key)]);
      return await work();
    } finally {
      await db.owner.query("ROLLBACK");
    }
  };
  const publicPost = (url: string, payload: object, headers: Record<string, string> = {}) =>
    test.app.inject({ method: "POST", url, headers: browserHeaders(headers), payload });
  const signUp = (email: string, headers: Record<string, string> = {}) =>
    publicPost(
      "/v1/staff/auth/sign-up",
      { email, password: PASSWORD, organizerName: "Paths Co", accept: ACCEPT },
      headers,
    );
  const signUpCode = (challengeToken: string, code: string) =>
    publicPost("/v1/staff/auth/sign-up/code", { challengeToken, code });
  const signUpResend = (challengeToken: string) =>
    publicPost("/v1/staff/auth/sign-up/resend", { challengeToken });
  const seedOutbound = (count: number) =>
    db.owner.query(
      "INSERT INTO auth_throttle (bucket, key) SELECT 'outbound_mail', $1 FROM generate_series(1, $2)",
      [OUTBOUND_KEY, count],
    );
  const resendsOf = async (email: string): Promise<number> =>
    (
      await owner<{ resends: number }>("SELECT resends FROM staff_signup WHERE email = $1", [email])
    )[0]?.resends ?? -1;
  const backdate = (email: string) =>
    owner("UPDATE staff_signup SET last_sent_at = now() - interval '61 seconds' WHERE email = $1", [
      email,
    ]);

  describe("the day's mail budget", () => {
    it("serves requests one at a time at its edge: exactly the remaining two get through", async () => {
      await seedOutbound(398);
      const results = await Promise.all(
        Array.from({ length: 10 }, () => takeOutboundMail(test.pool)),
      );
      expect(results.filter(Boolean)).toHaveLength(2);
    });

    it("refuses at exactly 400", async () => {
      await seedOutbound(400);
      expect(await takeOutboundMail(test.pool)).toBe(false);
      await seedOutbound(0);
    });
  });

  describe("starting a sign-up", () => {
    it("asks to retry in a second while another request for the email holds its lock, and logs the step", async () => {
      const email = newEmail();
      const response = await whileLocked(keys.emailKey(email), () => signUp(email));
      expect(response.statusCode).toBe(429);
      expect(response.headers["retry-after"]).toBe("1");
      expect(events("staff.throttled")).toEqual([{ step: "sign_up" }]);
    });

    it("logs the spent budget and a failed send, by name only", async () => {
      await seedOutbound(400);
      await signUp(newEmail());
      expect(events("staff.outbound_cap")).toEqual([{ step: "sign_up" }]);
      await db.owner.query("DELETE FROM auth_throttle WHERE bucket = 'outbound_mail'");
      test.mail.failing = true;
      try {
        await signUp(newEmail());
      } finally {
        test.mail.failing = false;
      }
      expect(events("staff.email_unavailable")).toEqual([{ reason: "EmailSendError" }]);
    });

    it("tells the person the code works for 10 minutes, and logs the start", async () => {
      const email = newEmail();
      await signUp(email);
      expect(test.mail.to(email).at(-1)?.text).toContain("It is valid for 10 minutes.");
      expect(events("staff.sign_up_started")).toEqual([{}]);
    });
  });

  describe("the code step", () => {
    it("asks to retry while the email's lock is held, and when its failure window is full", async () => {
      const email = newEmail();
      const token = tokenOf(await signUp(email));
      const held = await whileLocked(keys.emailKey(email), () => signUpCode(token, "000000"));
      expect(held.statusCode).toBe(429);
      expect(held.headers["retry-after"]).toBe("1");
      await db.owner.query(
        "INSERT INTO auth_throttle (bucket, key) SELECT $1, $2 FROM generate_series(1, 8)",
        [BUCKETS.failEmail, keys.emailKey(email)],
      );
      expect((await signUpCode(token, test.mail.lastCode(email))).statusCode).toBe(429);
    });

    it("refuses an expired sign-up without counting an attempt", async () => {
      const email = newEmail();
      const token = tokenOf(await signUp(email));
      await owner(
        "UPDATE staff_signup SET expires_at = now() - interval '1 second' WHERE email = $1",
        [email],
      );
      expect((await signUpCode(token, test.mail.lastCode(email))).statusCode).toBe(410);
      expect(await owner("SELECT attempts FROM staff_signup WHERE email = $1", [email])).toEqual([
        { attempts: 0 },
      ]);
    });

    it("logs a wrong code with the attempts left, and a completed sign-up with the new user", async () => {
      const email = newEmail();
      const token = tokenOf(await signUp(email));
      const code = test.mail.lastCode(email);
      await signUpCode(token, code === "000000" ? "000001" : "000000");
      expect(events("staff.code_failed")).toEqual([{ attemptsLeft: 4, step: "sign_up" }]);
      const done = await signUpCode(token, code);
      const id = done.json<{ account: { id: string } }>().account.id;
      expect(events("staff.signed_up")).toEqual([{ user: id }]);
      const audit = await owner<{ request_id: string }>(
        "SELECT request_id FROM audit_log WHERE action = 'organizer.create' AND actor_id = $1",
        [id],
      );
      expect(audit).toEqual([{ request_id: done.headers["x-request-id"] }]);
    });

    it("tries a second slug when the first is taken, and fails loudly when that is taken too", async () => {
      await owner(
        "INSERT INTO organizer (name, slug) VALUES ('Taken', 'taken-one'), ('Taken', 'taken-two')",
      );
      const first = newEmail();
      const firstToken = tokenOf(await signUp(first));
      control.slugs = ["taken-one", "fresh-slug-a1"];
      const done = await signUpCode(firstToken, test.mail.lastCode(first));
      expect(done.statusCode).toBe(200);
      const slug = await owner<{ slug: string }>("SELECT slug FROM organizer WHERE id = $1", [
        done.json<{ organizerId: string }>().organizerId,
      ]);
      expect(slug).toEqual([{ slug: "fresh-slug-a1" }]);

      const second = newEmail();
      const secondToken = tokenOf(await signUp(second));
      control.slugs = ["taken-one", "taken-two"];
      expect((await signUpCode(secondToken, test.mail.lastCode(second))).statusCode).toBe(500);
      expect(await owner("SELECT 1 FROM staff_user WHERE email = $1", [second])).toEqual([]);
    });
  });

  describe("a sign-up resend", () => {
    it("spends no resend when the budget is gone, and logs it", async () => {
      const email = newEmail();
      const token = tokenOf(await signUp(email));
      await backdate(email);
      await seedOutbound(400);
      const response = await signUpResend(token);
      expect(response.statusCode).toBe(503);
      expect(await resendsOf(email)).toBe(0);
      expect(events("staff.outbound_cap")).toEqual([{ step: "sign_up_resend" }]);
    });

    it("says how long to wait, stops after three, and answers an expired sign-up with 410", async () => {
      const email = newEmail();
      const token = tokenOf(await signUp(email));
      const soon = await signUpResend(token);
      expect(soon.statusCode).toBe(429);
      const wait = Number(soon.headers["retry-after"]);
      expect(wait).toBeGreaterThan(50);
      expect(wait).toBeLessThanOrEqual(60);
      for (let count = 0; count < 3; count += 1) {
        await backdate(email);
        const sent = await signUpResend(token);
        expect(sent.statusCode).toBe(200);
        expect(sent.json()).toEqual({});
      }
      await backdate(email);
      expect((await signUpResend(token)).json()).toMatchObject({ code: "resend_limit" });
      await owner(
        "UPDATE staff_signup SET expires_at = now() - interval '1 second' WHERE email = $1",
        [email],
      );
      expect((await signUpResend(token)).statusCode).toBe(410);
    });

    it("answers 503 when the new code cannot be sent", async () => {
      const email = newEmail();
      const token = tokenOf(await signUp(email));
      await backdate(email);
      test.mail.failing = true;
      try {
        expect((await signUpResend(token)).statusCode).toBe(503);
      } finally {
        test.mail.failing = false;
      }
    });
  });

  describe("creating another organizer", () => {
    it("asks to retry while the person's lock is held, and logs and audits a creation", async () => {
      const email = newEmail();
      const id = await createStaff(db.owner, { email, password: "correct horse battery staple" });
      const cookie = await signInFully(test, email);
      const create = () =>
        test.app.inject({
          method: "POST",
          url: "/v1/staff/organizers",
          headers: withSession(cookie, { "idempotency-key": randomUUID() }),
          payload: { name: "Locked Co", accept: ACCEPT },
        });
      const held = await whileLocked(keys.userKey(id), create);
      expect(held.statusCode).toBe(429);
      lines = [];
      const made = await create();
      expect(events("staff.organizer_created")).toEqual([{ user: id }]);
      const audit = await owner<{ request_id: string }>(
        "SELECT request_id FROM audit_log WHERE action = 'organizer.create' AND organizer_id = $1",
        [made.json<{ organizerId: string }>().organizerId],
      );
      expect(audit).toEqual([{ request_id: made.headers["x-request-id"] }]);
    });
  });

  /** A new organizer with a signed-in owner. */
  const newOrganizer = async () => {
    const ownerEmail = newEmail("owner");
    const ownerId = await createStaff(db.owner, { email: ownerEmail });
    const [row] = await owner<{ id: string }>(
      "INSERT INTO organizer (name, slug) VALUES ('Paths Org', $1) RETURNING id",
      [`paths-${counter}`],
    );
    await owner(
      "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, 'owner')",
      [row?.id, ownerId],
    );
    return { id: row?.id ?? "", ownerId, cookie: await signInFully(test, ownerEmail) };
  };
  const call = (
    method: "POST" | "PATCH" | "DELETE",
    url: string,
    cookie: string,
    payload?: object,
  ) =>
    test.app.inject({
      method,
      url,
      headers: withSession(cookie),
      ...(payload === undefined ? {} : { payload }),
    });
  const inviteTokenFor = (email: string): string => {
    const mail = test.mail.to(email).filter((message) => message.text.includes("/invite#token="));
    return /\/invite#token=([A-Za-z0-9_-]{43})/.exec(mail.at(-1)?.text ?? "")?.[1] ?? "";
  };
  const newEvent = async (org: string): Promise<string> =>
    (
      await owner<{ id: string }>(
        "INSERT INTO event (organizer_id, join_code, name_en) VALUES ($1, $2, 'E') RETURNING id",
        [org, `P${counter}${Math.floor(Math.random() * 1e6)}`],
      )
    )[0]?.id ?? "";

  describe("sending invites", () => {
    it("answers with the invite's id, says the link works 7 days, and audits the limit's size only", async () => {
      const org = await newOrganizer();
      const event = await newEvent(org.id);
      const scoped = newEmail("scoped");
      const sent = await call("POST", `/v1/organizers/${org.id}/invites`, org.cookie, {
        email: scoped,
        eventScope: [event, event],
      });
      expect(sent.statusCode).toBe(201);
      expect(sent.json<{ id: string }>().id).toMatch(/^[0-9a-f-]{36}$/);
      expect(test.mail.to(scoped).at(-1)?.text).toContain("The link works for 7 days.");
      expect(events("staff.invite_sent")).toEqual([{ user: org.ownerId }]);
      await call("POST", `/v1/organizers/${org.id}/invites`, org.cookie, { email: newEmail() });
      const audit = await owner<{ after: unknown }>(
        "SELECT after FROM audit_log WHERE organizer_id = $1 AND action = 'organizer.member.invite' ORDER BY id",
        [org.id],
      );
      expect(audit.map((row) => row.after)).toEqual([
        { role: "editor", limitedToEvents: 2 },
        { role: "editor", limitedToEvents: null },
      ]);
    });

    it("refuses an invalid email, and asks to retry while the organizer's counter is held", async () => {
      const org = await newOrganizer();
      expect(
        (
          await call("POST", `/v1/organizers/${org.id}/invites`, org.cookie, {
            email: "nobody here",
          })
        ).statusCode,
      ).toBe(400);
      const held = await whileLocked(keys.organizerKey(org.id), () =>
        call("POST", `/v1/organizers/${org.id}/invites`, org.cookie, { email: newEmail() }),
      );
      expect(held.statusCode).toBe(429);
      expect(held.headers["retry-after"]).toBe("1");
      expect(held.json()).toMatchObject({ details: { retryAfterSeconds: 1 } });
    });

    it("logs the spent budget and a failed send under the invite step", async () => {
      const org = await newOrganizer();
      await seedOutbound(400);
      await call("POST", `/v1/organizers/${org.id}/invites`, org.cookie, { email: newEmail() });
      expect(events("staff.outbound_cap")).toEqual([{ step: "invite" }]);
      await db.owner.query("DELETE FROM auth_throttle WHERE bucket = 'outbound_mail'");
      test.mail.failing = true;
      try {
        await call("POST", `/v1/organizers/${org.id}/invites`, org.cookie, { email: newEmail() });
      } finally {
        test.mail.failing = false;
      }
      expect(events("staff.email_unavailable")).toEqual([
        { reason: "EmailSendError", step: "invite" },
      ]);
    });

    it("links to the invite page in the language the owner asked for, Arabic when none was given", async () => {
      const org = await newOrganizer();
      const english = newEmail("english");
      await call("POST", `/v1/organizers/${org.id}/invites`, org.cookie, {
        email: english,
        lang: "en",
      });
      expect(test.mail.to(english).at(-1)?.text).toMatch(/\/en\/invite#token=/);
      const arabic = newEmail("arabic");
      await call("POST", `/v1/organizers/${org.id}/ownership`, org.cookie, { email: arabic });
      expect(test.mail.to(arabic).at(-1)?.text).toMatch(/\/ar\/invite#token=/);
      expect(
        (
          await call("POST", `/v1/organizers/${org.id}/invites`, org.cookie, {
            email: newEmail(),
            lang: "fr",
          })
        ).statusCode,
      ).toBe(400);
    });

    it("records an invite that could not be sent as cancelled, with the reason", async () => {
      const org = await newOrganizer();
      test.mail.failing = true;
      try {
        await call("POST", `/v1/organizers/${org.id}/invites`, org.cookie, { email: newEmail() });
      } finally {
        test.mail.failing = false;
      }
      const audit = await owner<{ action: string; after: unknown }>(
        "SELECT action, after FROM audit_log WHERE organizer_id = $1 ORDER BY id",
        [org.id],
      );
      expect(audit).toEqual([
        { action: "organizer.member.invite", after: { role: "editor", limitedToEvents: null } },
        { action: "organizer.member.invite_cancel", after: { reason: "not_sent" } },
      ]);
    });

    it("refuses a cookie request with no Origin, as every change from another site", async () => {
      const org = await newOrganizer();
      const response = await test.app.inject({
        method: "POST",
        url: `/v1/organizers/${org.id}/invites`,
        headers: { cookie: org.cookie, "x-forwarded-for": freshIp() },
        payload: { email: newEmail() },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ code: "csrf_rejected" });
    });
  });

  describe("changing the team", () => {
    it("answers 404 for an invite, a member or an owner that cannot be changed, and 422 for another's event", async () => {
      const org = await newOrganizer();
      const other = await newOrganizer();
      const missing = randomUUID();
      expect(
        (await call("DELETE", `/v1/organizers/${org.id}/invites/${missing}`, org.cookie))
          .statusCode,
      ).toBe(404);
      expect(
        (await call("DELETE", `/v1/organizers/${org.id}/members/${missing}`, org.cookie))
          .statusCode,
      ).toBe(404);
      expect(
        (
          await call("PATCH", `/v1/organizers/${org.id}/members/${org.ownerId}`, org.cookie, {
            eventScope: null,
          })
        ).statusCode,
      ).toBe(404);
      const foreign = await newEvent(other.id);
      const refused = await call(
        "PATCH",
        `/v1/organizers/${org.id}/members/${missing}`,
        org.cookie,
        {
          eventScope: [foreign],
        },
      );
      expect(refused.statusCode).toBe(422);
      expect(refused.json()).toMatchObject({ code: "invalid_scope" });
    });

    it("records no removal when the member changed in between, and answers an error", async () => {
      const org = await newOrganizer();
      const editor = await createStaff(db.owner, { email: newEmail("slippery") });
      await owner(
        "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, 'editor')",
        [org.id, editor],
      );
      // A test-only trigger skips the delete, as if ownership had moved between the read and the delete.
      await db.owner.query(`
        CREATE FUNCTION test_keep_member() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
        CREATE TRIGGER test_keep_member BEFORE DELETE ON organizer_member FOR EACH ROW
          WHEN (OLD.staff_user_id = '${editor}') EXECUTE FUNCTION test_keep_member();`);
      try {
        const response = await call(
          "DELETE",
          `/v1/organizers/${org.id}/members/${editor}`,
          org.cookie,
        );
        expect(response.statusCode).toBe(500);
      } finally {
        await db.owner.query(
          "DROP TRIGGER test_keep_member ON organizer_member; DROP FUNCTION test_keep_member();",
        );
      }
      const audit = await owner(
        "SELECT 1 FROM audit_log WHERE organizer_id = $1 AND action = 'organizer.member.remove'",
        [org.id],
      );
      expect(audit).toEqual([]);
    });

    it("audits an editor's new limit by its size", async () => {
      const org = await newOrganizer();
      const editor = await createStaff(db.owner, { email: newEmail("editor") });
      await owner(
        "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, 'editor')",
        [org.id, editor],
      );
      const event = await newEvent(org.id);
      const changed = await call(
        "PATCH",
        `/v1/organizers/${org.id}/members/${editor}`,
        org.cookie,
        {
          eventScope: [event],
        },
      );
      expect(changed.statusCode).toBe(204);
      expect(
        await owner("SELECT event_scope FROM organizer_member WHERE staff_user_id = $1", [editor]),
      ).toEqual([{ event_scope: [event] }]);
      const audit = await owner<{ after: unknown }>(
        "SELECT after FROM audit_log WHERE organizer_id = $1 AND action = 'organizer.member.scope'",
        [org.id],
      );
      expect(audit).toEqual([{ after: { limitedToEvents: 1 } }]);
    });
  });

  describe("accepting invites", () => {
    it("says when the invited email already has an account", async () => {
      const org = await newOrganizer();
      const email = newEmail("existing");
      await createStaff(db.owner, { email });
      await call("POST", `/v1/organizers/${org.id}/invites`, org.cookie, { email });
      const shown = await publicPost("/v1/staff/invites/inspect", { token: inviteTokenFor(email) });
      expect(shown.json()).toMatchObject({ accountExists: true });
    });

    it("logs and audits an acceptance with its request", async () => {
      const org = await newOrganizer();
      const email = newEmail("joiner");
      const id = await createStaff(db.owner, { email });
      await call("POST", `/v1/organizers/${org.id}/invites`, org.cookie, { email });
      const cookie = await signInFully(test, email);
      lines = [];
      const accepted = await test.app.inject({
        method: "POST",
        url: "/v1/staff/invites/accept",
        headers: withSession(cookie),
        payload: { token: inviteTokenFor(email) },
      });
      expect(accepted.json()).toEqual({ organizerId: org.id });
      expect(events("staff.invite_accepted")).toEqual([{ user: id }]);
      const audit = await owner<{ request_id: string }>(
        "SELECT request_id FROM audit_log WHERE organizer_id = $1 AND action = 'organizer.member.join'",
        [org.id],
      );
      expect(audit).toEqual([{ request_id: accepted.headers["x-request-id"] }]);
    });

    it("refuses an unknown link, a spent address allowance, and a breach list that cannot answer", async () => {
      const org = await newOrganizer();
      expect(
        (
          await publicPost("/v1/staff/invites/accept-new", {
            token: "Y".repeat(43),
            password: PASSWORD,
          })
        ).statusCode,
      ).toBe(410);
      const ip = freshIp();
      for (let count = 0; count < 20; count += 1) {
        await publicPost(
          "/v1/staff/invites/inspect",
          { token: "Y".repeat(43) },
          { "x-forwarded-for": ip },
        );
      }
      const blocked = await publicPost(
        "/v1/staff/invites/accept-new",
        { token: "Y".repeat(43), password: PASSWORD },
        { "x-forwarded-for": ip },
      );
      expect(blocked.statusCode).toBe(429);
      const email = newEmail("unchecked");
      await call("POST", `/v1/organizers/${org.id}/invites`, org.cookie, { email });
      test.breach.down = true;
      try {
        const down = await publicPost("/v1/staff/invites/accept-new", {
          token: inviteTokenFor(email),
          password: PASSWORD,
        });
        expect(down.statusCode).toBe(503);
      } finally {
        test.breach.down = false;
      }
      expect(await owner("SELECT 1 FROM staff_user WHERE email = $1", [email])).toEqual([]);
    });

    it("passes on the sign-in step's answer when the new account's code cannot be sent or the gate is full", async () => {
      const org = await newOrganizer();
      const unsent = newEmail("unsent");
      await call("POST", `/v1/organizers/${org.id}/invites`, org.cookie, { email: unsent });
      const token = inviteTokenFor(unsent);
      test.mail.failing = true;
      try {
        const response = await publicPost("/v1/staff/invites/accept-new", {
          token,
          password: PASSWORD,
        });
        expect(response.statusCode).toBe(503);
        expect(response.json()).toMatchObject({ code: "email_unavailable" });
      } finally {
        test.mail.failing = false;
      }
      expect(await owner("SELECT 1 FROM staff_user WHERE email = $1", [unsent])).toHaveLength(1);
      expect(events("staff.invite_accepted_new")).toEqual([{}]);

      const busy = newEmail("busy");
      await call("POST", `/v1/organizers/${org.id}/invites`, org.cookie, { email: busy });
      control.gateCalls = 0;
      control.gateBusyOnCall = 2;
      const response = await publicPost("/v1/staff/invites/accept-new", {
        token: inviteTokenFor(busy),
        password: PASSWORD,
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ code: "busy" });

      const limited = newEmail("limited");
      await call("POST", `/v1/organizers/${org.id}/invites`, org.cookie, { email: limited });
      await db.owner.query(
        "INSERT INTO auth_throttle (bucket, key) SELECT $1, $2 FROM generate_series(1, 8)",
        [BUCKETS.failEmail, keys.emailKey(limited)],
      );
      const throttled = await publicPost("/v1/staff/invites/accept-new", {
        token: inviteTokenFor(limited),
        password: PASSWORD,
      });
      expect(throttled.statusCode).toBe(429);
    });

    it("lets the new account finish signing in with the emailed code", async () => {
      const org = await newOrganizer();
      const email = newEmail("finisher");
      await call("POST", `/v1/organizers/${org.id}/invites`, org.cookie, { email });
      const accepted = await publicPost("/v1/staff/invites/accept-new", {
        token: inviteTokenFor(email),
        password: PASSWORD,
      });
      const done = await postCode(test, tokenOf(accepted), test.mail.lastCode(email));
      expect(done.statusCode).toBe(200);
      expect(sessionCookieOf(done)).toMatch(/^__Host-qs_session=/);
    });
  });
});
