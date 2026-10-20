import { createHash } from "node:crypto";
import type { LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DASHBOARD_ORIGIN,
  PASSWORD,
  browserHeaders,
  createStaff,
  freshIp,
  postCode,
  sessionCookieOf,
  signInFully,
  startApp,
  withSession,
  type TestApp,
} from "#test/support/auth-app";
import { TEST_DATABASE_URL, createTestDatabase, type TestDatabase } from "#test/support/test-db";

const NEW_PASSWORD = "an editor's own pass phrase";
const OUTBOUND_KEY = createHash("sha256").update("questify.outbound_mail").digest();

describe.skipIf(TEST_DATABASE_URL === undefined)("the organizer team (T-101)", () => {
  let db: TestDatabase;
  let test: TestApp;
  let counter = 0;
  const newEmail = (who = "person"): string => {
    counter += 1;
    return `${who}${counter}@team.test`;
  };

  beforeAll(async () => {
    db = await createTestDatabase();
    test = await startApp(db);
  });
  afterAll(async () => {
    await test.close();
    await db.close();
  });

  const owner = <T extends Record<string, unknown>>(sql: string, values: unknown[] = []) =>
    db.owner.query<T>(sql, values).then((result) => result.rows);

  /** A new organizer with a signed-in owner. */
  const newOrganizer = async (): Promise<{ id: string; ownerEmail: string; cookie: string }> => {
    const ownerEmail = newEmail("owner");
    const ownerId = await createStaff(db.owner, { email: ownerEmail });
    const [row] = await owner<{ id: string }>(
      "INSERT INTO organizer (name, slug) VALUES ('Najd Events', $1) RETURNING id",
      [`najd-${counter}`],
    );
    await owner(
      "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, 'owner')",
      [row?.id, ownerId],
    );
    return { id: row?.id ?? "", ownerEmail, cookie: await signInFully(test, ownerEmail) };
  };

  const call = (
    method: "GET" | "POST" | "PATCH" | "DELETE",
    url: string,
    cookie: string,
    payload?: object,
  ): Promise<LightMyRequestResponse> =>
    test.app.inject({
      method,
      url,
      headers: withSession(cookie),
      ...(payload === undefined ? {} : { payload }),
    });

  const invite = (org: string, cookie: string, email: string, eventScope?: string[]) =>
    call("POST", `/v1/organizers/${org}/invites`, cookie, {
      email,
      ...(eventScope === undefined ? {} : { eventScope }),
    });

  /** The token in the newest invite emailed to this address (sign-in codes come to the same mailbox). */
  const tokenFor = (email: string): string => {
    const invites = test.mail.to(email).filter((mail) => mail.text.includes("/invite#token="));
    const token = /\/invite#token=([A-Za-z0-9_-]{43})/.exec(invites.at(-1)?.text ?? "")?.[1];
    if (token === undefined) {
      throw new Error(`No invite was emailed to ${email}.`);
    }
    return token;
  };

  const publicPost = (url: string, payload: object, headers: Record<string, string> = {}) =>
    test.app.inject({ method: "POST", url, headers: browserHeaders(headers), payload });

  /** Accepts an invite as someone new: password, then the emailed sign-in code. Returns their session cookie. */
  const joinAsNew = async (email: string): Promise<string> => {
    const accepted = await publicPost("/v1/staff/invites/accept-new", {
      token: tokenFor(email),
      password: NEW_PASSWORD,
    });
    expect(accepted.statusCode).toBe(200);
    const { challengeToken } = accepted.json<{ challengeToken: string }>();
    const done = await postCode(test, challengeToken, test.mail.lastCode(email));
    expect(done.statusCode).toBe(200);
    return sessionCookieOf(done);
  };

  const membersOf = async (org: string, cookie: string) =>
    (await call("GET", `/v1/organizers/${org}/members`, cookie)).json<{
      members: { staffUserId: string; email: string; role: string; eventScope: string[] | null }[];
      invites: { email: string; role: string }[];
    }>();

  const newEvent = async (org: string): Promise<string> =>
    (
      await owner<{ id: string }>(
        "INSERT INTO event (organizer_id, join_code, name_en) VALUES ($1, $2, 'An Event') RETURNING id",
        [org, `EV${counter}${Math.floor(Math.random() * 1e6)}`],
      )
    )[0]?.id ?? "";

  describe("inviting an editor who has no account", () => {
    it("emails a link; the link shows the organizer; a password and the sign-in code make them an editor", async () => {
      const org = await newOrganizer();
      const email = newEmail("editor");
      const sent = await invite(org.id, org.cookie, email);
      expect(sent.statusCode).toBe(201);
      const mail = test.mail.to(email).at(-1);
      expect(mail?.text).toContain(`${DASHBOARD_ORIGIN}/ar/invite#token=`);
      expect(mail?.text).toContain("«Najd Events»");
      expect((await membersOf(org.id, org.cookie)).invites).toEqual([
        expect.objectContaining({ email, role: "editor" }),
      ]);

      const shown = await publicPost("/v1/staff/invites/inspect", { token: tokenFor(email) });
      expect(shown.json()).toEqual({
        organizerName: "Najd Events",
        role: "editor",
        email,
        accountExists: false,
      });

      const cookie = await joinAsNew(email);
      const me = await test.app.inject({ url: "/v1/staff/me", headers: withSession(cookie) });
      expect(me.json()).toMatchObject({ memberships: [{ organizerId: org.id, role: "editor" }] });
      const team = await membersOf(org.id, org.cookie);
      expect(team.members.map((member) => [member.email, member.role])).toEqual([
        [org.ownerEmail, "owner"],
        [email, "editor"],
      ]);
      expect(team.invites).toEqual([]);
      expect(
        (await publicPost("/v1/staff/invites/inspect", { token: tokenFor(email) })).statusCode,
      ).toBe(410);
    });

    it("refuses a weak password and keeps the invite", async () => {
      const org = await newOrganizer();
      const email = newEmail("editor");
      await invite(org.id, org.cookie, email);
      const weak = await publicPost("/v1/staff/invites/accept-new", {
        token: tokenFor(email),
        password: "short",
      });
      expect(weak.json()).toMatchObject({
        code: "weak_password",
        details: { reason: "too_short" },
      });
      expect(
        (await publicPost("/v1/staff/invites/inspect", { token: tokenFor(email) })).statusCode,
      ).toBe(200);
    });

    it("asks someone who has an account to sign in instead", async () => {
      const org = await newOrganizer();
      const email = newEmail("editor");
      await createStaff(db.owner, { email });
      await invite(org.id, org.cookie, email);
      const response = await publicPost("/v1/staff/invites/accept-new", {
        token: tokenFor(email),
        password: NEW_PASSWORD,
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code: "sign_in_to_accept" });
    });
  });

  describe("inviting someone who has an account", () => {
    it("lets only the invited account accept it, once", async () => {
      const org = await newOrganizer();
      const email = newEmail("editor");
      await createStaff(db.owner, { email });
      const other = newEmail("other");
      await createStaff(db.owner, { email: other });
      await invite(org.id, org.cookie, email);
      const token = tokenFor(email);
      const wrong = await call("POST", "/v1/staff/invites/accept", await signInFully(test, other), {
        token,
      });
      expect(wrong.statusCode).toBe(403);
      expect(wrong.json()).toMatchObject({ code: "invite_other_account" });
      const cookie = await signInFully(test, email);
      const right = await call("POST", "/v1/staff/invites/accept", cookie, { token });
      expect(right.json()).toEqual({ organizerId: org.id });
      expect((await call("POST", "/v1/staff/invites/accept", cookie, { token })).statusCode).toBe(
        410,
      );
      expect((await invite(org.id, org.cookie, email)).json()).toMatchObject({
        code: "already_member",
      });
    });
  });

  describe("the owner's controls", () => {
    it("refuses an editor every team change, and inviting yourself", async () => {
      const org = await newOrganizer();
      const email = newEmail("editor");
      await invite(org.id, org.cookie, email);
      const editor = await joinAsNew(email);
      const refused = await invite(org.id, editor, newEmail());
      expect(refused.statusCode).toBe(403);
      expect(refused.json()).toMatchObject({ code: "owner_only" });
      expect((await invite(org.id, org.cookie, org.ownerEmail.toUpperCase())).json()).toMatchObject(
        {
          code: "invite_self",
        },
      );
    });

    it("limits an editor to chosen events from the invite, then lifts the limit", async () => {
      const org = await newOrganizer();
      const eventA = await newEvent(org.id);
      const email = newEmail("editor");
      await invite(org.id, org.cookie, email, [eventA]);
      await joinAsNew(email);
      const limited = (await membersOf(org.id, org.cookie)).members.find(
        (member) => member.email === email,
      );
      expect(limited?.eventScope).toEqual([eventA]);
      const lifted = await call(
        "PATCH",
        `/v1/organizers/${org.id}/members/${limited?.staffUserId}`,
        org.cookie,
        {
          eventScope: null,
        },
      );
      expect(lifted.statusCode).toBe(204);
      const after = (await membersOf(org.id, org.cookie)).members.find(
        (member) => member.email === email,
      );
      expect(after?.eventScope).toBeNull();
    });

    it("refuses a limit that names another organizer's event, or none at all", async () => {
      const org = await newOrganizer();
      const other = await newOrganizer();
      const foreign = await newEvent(other.id);
      expect((await invite(org.id, org.cookie, newEmail(), [foreign])).json()).toMatchObject({
        code: "invalid_scope",
      });
      expect((await invite(org.id, org.cookie, newEmail(), [])).statusCode).toBe(400);
    });

    it("removes an editor, who then sees the organizer as missing; never the owner themselves", async () => {
      const org = await newOrganizer();
      const email = newEmail("editor");
      await invite(org.id, org.cookie, email);
      const editor = await joinAsNew(email);
      const editorId = (await membersOf(org.id, org.cookie)).members.find(
        (member) => member.email === email,
      )?.staffUserId;
      const ownerId = (await membersOf(org.id, org.cookie)).members.find(
        (member) => member.role === "owner",
      )?.staffUserId;
      const byEditor = await call("DELETE", `/v1/organizers/${org.id}/members/${ownerId}`, editor);
      expect(byEditor.json()).toMatchObject({ code: "owner_only" });
      const self = await call("DELETE", `/v1/organizers/${org.id}/members/${ownerId}`, org.cookie);
      expect(self.statusCode).toBe(409);
      expect(self.json()).toMatchObject({ code: "owner_required" });
      expect(
        (await call("DELETE", `/v1/organizers/${org.id}/members/${editorId}`, org.cookie))
          .statusCode,
      ).toBe(204);
      expect((await call("GET", `/v1/organizers/${org.id}/members`, editor)).statusCode).toBe(404);
    });

    it("lets an editor leave, and tells the owner they cannot", async () => {
      const org = await newOrganizer();
      const email = newEmail("editor");
      await invite(org.id, org.cookie, email);
      const editor = await joinAsNew(email);
      expect(
        (await call("DELETE", `/v1/organizers/${org.id}/members/me`, org.cookie)).statusCode,
      ).toBe(409);
      expect((await call("DELETE", `/v1/organizers/${org.id}/members/me`, editor)).statusCode).toBe(
        204,
      );
      expect((await call("GET", `/v1/organizers/${org.id}/members`, editor)).statusCode).toBe(404);
    });

    it("cancels an invite, after which its link opens nothing; re-inviting replaces the link", async () => {
      const org = await newOrganizer();
      const email = newEmail("editor");
      await invite(org.id, org.cookie, email);
      const first = tokenFor(email);
      await invite(org.id, org.cookie, email);
      const second = tokenFor(email);
      expect((await publicPost("/v1/staff/invites/inspect", { token: first })).statusCode).toBe(
        410,
      );
      const [pending] = (await membersOf(org.id, org.cookie)).invites as unknown as {
        id: string;
      }[];
      expect(
        (await call("DELETE", `/v1/organizers/${org.id}/invites/${pending?.id}`, org.cookie))
          .statusCode,
      ).toBe(204);
      expect((await publicPost("/v1/staff/invites/inspect", { token: second })).statusCode).toBe(
        410,
      );
    });
  });

  describe("transferring ownership", () => {
    it("makes the invited editor the owner and the old owner an editor", async () => {
      const org = await newOrganizer();
      const email = newEmail("editor");
      await invite(org.id, org.cookie, email);
      const editor = await joinAsNew(email);
      const sent = await call("POST", `/v1/organizers/${org.id}/ownership`, org.cookie, { email });
      expect(sent.statusCode).toBe(201);
      expect(test.mail.to(email).at(-1)?.subject).toContain("Become an organizer's owner");
      const accepted = await call("POST", "/v1/staff/invites/accept", editor, {
        token: tokenFor(email),
      });
      expect(accepted.statusCode).toBe(200);
      const roles = (await membersOf(org.id, editor)).members.map((member) => [
        member.email,
        member.role,
      ]);
      expect(roles).toEqual([
        [email, "owner"],
        [org.ownerEmail, "editor"],
      ]);
      expect((await invite(org.id, org.cookie, newEmail())).statusCode).toBe(403);
      const audit = await owner<{ action: string }>(
        "SELECT action FROM audit_log WHERE organizer_id = $1 AND action LIKE 'organizer.owner.%' ORDER BY id",
        [org.id],
      );
      expect(audit.map((row) => row.action)).toEqual([
        "organizer.owner.invite",
        "organizer.owner.transfer",
      ]);
    });
  });

  describe("limits", () => {
    it("allows ten invites a day before any event is activated", async () => {
      const org = await newOrganizer();
      for (let count = 0; count < 10; count += 1) {
        expect((await invite(org.id, org.cookie, newEmail())).statusCode).toBe(201);
      }
      expect((await invite(org.id, org.cookie, newEmail())).statusCode).toBe(429);
    });

    it("holds at most twenty pending invites once an event is activated", async () => {
      const org = await newOrganizer();
      const event = await newEvent(org.id);
      await owner(
        "UPDATE event SET status = 'live', starts_at = now() - interval '1 hour', ends_at = now() + interval '30 days' WHERE id = $1",
        [event],
      );
      for (let count = 0; count < 20; count += 1) {
        expect((await invite(org.id, org.cookie, newEmail())).statusCode).toBe(201);
      }
      const full = await invite(org.id, org.cookie, newEmail());
      expect(full.statusCode).toBe(409);
      expect(full.json()).toMatchObject({ code: "invites_pending_full" });
    });

    it("answers mail_cap and keeps no invite when the day's mail budget is spent", async () => {
      const org = await newOrganizer();
      await db.owner.query(
        "INSERT INTO auth_throttle (bucket, key) SELECT 'outbound_mail', $1 FROM generate_series(1, 400)",
        [OUTBOUND_KEY],
      );
      try {
        const response = await invite(org.id, org.cookie, newEmail());
        expect(response.statusCode).toBe(429);
        expect(response.json()).toMatchObject({ code: "mail_cap" });
      } finally {
        await db.owner.query("DELETE FROM auth_throttle WHERE bucket = 'outbound_mail'");
      }
      expect((await membersOf(org.id, org.cookie)).invites).toEqual([]);
    });

    it("answers 503 and keeps no invite when the email cannot be sent", async () => {
      const org = await newOrganizer();
      test.mail.failing = true;
      try {
        expect((await invite(org.id, org.cookie, newEmail())).statusCode).toBe(503);
      } finally {
        test.mail.failing = false;
      }
      expect((await membersOf(org.id, org.cookie)).invites).toEqual([]);
    });

    it("limits how often one address may look at or accept invite links", async () => {
      const ip = freshIp();
      for (let count = 0; count < 20; count += 1) {
        await publicPost(
          "/v1/staff/invites/inspect",
          { token: "Z".repeat(43) },
          { "x-forwarded-for": ip },
        );
      }
      const blocked = await publicPost(
        "/v1/staff/invites/inspect",
        { token: "Z".repeat(43) },
        {
          "x-forwarded-for": ip,
        },
      );
      expect(blocked.statusCode).toBe(429);
    });
  });

  describe("the audit trail", () => {
    it("records invites and joins without any email", async () => {
      const org = await newOrganizer();
      const email = newEmail("editor");
      await invite(org.id, org.cookie, email);
      await joinAsNew(email);
      const rows = await owner<{ action: string; after: unknown }>(
        "SELECT action, after FROM audit_log WHERE organizer_id = $1 ORDER BY id",
        [org.id],
      );
      expect(rows.map((row) => row.action)).toEqual([
        "organizer.member.invite",
        "organizer.member.join",
      ]);
      expect(JSON.stringify(rows)).not.toContain("@");
      expect(PASSWORD).toBeDefined();
    });
  });
});
