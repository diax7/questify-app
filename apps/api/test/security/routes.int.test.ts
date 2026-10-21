import type { LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  browserHeaders,
  createStaff,
  signInFully,
  startApp,
  withSession,
  type TestApp,
} from "#test/support/auth-app";
import {
  TEST_DATABASE_URL,
  createTestDatabase,
  seedTwoTenants,
  type TestDatabase,
} from "#test/support/test-db";

/**
 * The outsider and cross-tenant suites on the HTTP routes (T-012). Every route must appear in ROUTES with how it
 * keeps one caller out of another's data; a new route fails the first test until that is decided and proven.
 */
const ROUTES: Readonly<Record<string, string>> = {
  "GET /healthz": "no data: process liveness",
  "GET /readyz": "no data: database reachability",
  "GET /v1/translations": "no tenant data: the same platform texts for everyone",
  "GET /v1/config": "another organizer's private event answers like a missing one (tested below)",
  "POST /v1/staff/auth/password":
    "sign-in step; answers the same for every account (test/auth/sign-in)",
  "POST /v1/staff/auth/code": "sign-in step; bound to its own challenge token (test/auth/sign-in)",
  "POST /v1/staff/auth/resend":
    "sign-in step; bound to its own challenge token (test/auth/sign-in)",
  "GET /v1/staff/me": "only the caller's own account and memberships (tested below)",
  "GET /v1/staff/sessions": "only the caller's own sessions (tested below)",
  "DELETE /v1/staff/sessions/:id":
    "another person's session answers 404 and stays live (tested below)",
  "POST /v1/staff/auth/sign-out": "ends only the caller's own session (tested below)",
  "POST /v1/staff/auth/reset/request":
    "names no account: the same 202 for every email; the link goes only to the account's own mailbox (test/auth/password-reset)",
  "POST /v1/staff/auth/reset/confirm":
    "bound to the one link its secret token opens (test/auth/password-reset, test/db/password-reset)",
  "POST /v1/staff/auth/sign-up":
    "names no account: the same answer for a new and an existing email; only the mailbox owner reads the email (test/auth/sign-up)",
  "POST /v1/staff/auth/sign-up/code":
    "bound to its own pending sign-up token; creates only that sign-up's account (test/auth/sign-up)",
  "POST /v1/staff/auth/sign-up/resend":
    "bound to its own pending sign-up token (test/auth/sign-up)",
  "POST /v1/staff/organizers":
    "creates an organizer owned by the caller only; the database sets the owner from the session (test/auth/sign-up)",
  "POST /v1/staff/invites/inspect":
    "shows only the invite its secret token opens; the token's holder already proved the mailbox (test/organizers/team)",
  "POST /v1/staff/invites/accept":
    "the database accepts only for the account the invite was sent to (test/organizers/team, test/db/organizer-team)",
  "POST /v1/staff/invites/accept-new":
    "bound to its own invite token; creates only the invited email's account, then a normal sign-in code (test/organizers/team)",
  "POST /v1/organizers/:organizerId/invites":
    "owner of that organizer only (owner route, walked below)",
  "POST /v1/organizers/:organizerId/ownership":
    "owner of that organizer only (owner route, walked below)",
  "DELETE /v1/organizers/:organizerId/invites/:inviteId":
    "owner only; another organizer's invite id deletes nothing (404)",
  "PATCH /v1/organizers/:organizerId/members/:staffUserId":
    "owner only; only this organizer's editors and events (test/organizers/team)",
  "DELETE /v1/organizers/:organizerId/members/:staffUserId":
    "owner only; only this organizer's editors, never the owner (test/organizers/team)",
  "DELETE /v1/organizers/:organizerId/members/me":
    "the caller leaves; the owner cannot (test/organizers/team)",
  "GET /v1/organizers/:organizerId/members":
    "members of that organizer only: the membership is read from the database, a non-member gets 404 (tested below)",
  "GET /v1/organizers/:organizerId/events":
    "members of that organizer only; a limited editor sees only their events (test/events/events)",
  "POST /v1/organizers/:organizerId/events":
    "members of that organizer only; the database sets nothing outside it; a limited editor cannot create (test/events/events)",
  "GET /v1/organizers/:organizerId/events/:eventId":
    "another organizer's event, or one outside an editor's limit, answers 404 (test/events/events)",
  "PATCH /v1/organizers/:organizerId/events/:eventId":
    "only this organizer's events within the caller's limit; status and organizer are not writable (test/events/events, test/db/event-lifecycle)",
  "DELETE /v1/organizers/:organizerId/events/:eventId":
    "only this organizer's drafts within the caller's limit (test/events/events, test/db/event-lifecycle)",
  "POST /v1/organizers/:organizerId/events/:eventId/end":
    "owner only (walked below); the database checks the owner again (test/events/events, test/db/event-lifecycle)",
  "GET /v1/organizers/:organizerId/events/:eventId/quests":
    "members of that organizer within their event limit; another event answers 404 (test/quests/builder)",
  "POST /v1/organizers/:organizerId/events/:eventId/categories":
    "only into the path's event, which the caller may reach; the database sets the organizer (test/quests/builder, test/db/quest-builder)",
  "PUT /v1/organizers/:organizerId/events/:eventId/categories/order":
    "only the path's event's categories, as an exact set (test/quests/builder)",
  "PATCH /v1/organizers/:organizerId/events/:eventId/categories/:categoryId":
    "a category of another event answers 404 (test/quests/builder)",
  "DELETE /v1/organizers/:organizerId/events/:eventId/categories/:categoryId":
    "a category of another event answers 404; quests move only within the event (test/quests/builder)",
  "PUT /v1/organizers/:organizerId/events/:eventId/categories/:categoryId/quests/order":
    "a category of another event answers 404 (test/quests/builder)",
  "POST /v1/organizers/:organizerId/events/:eventId/quests":
    "only into a category of the path's event (test/quests/builder, test/db/quest-builder)",
  "PATCH /v1/organizers/:organizerId/events/:eventId/quests/:questId":
    "a quest of another event answers 404, so a live event's confirmation cannot be skipped (test/quests/builder)",
  "DELETE /v1/organizers/:organizerId/events/:eventId/quests/:questId":
    "a quest of another event answers 404 (test/quests/builder)",
  "GET /v1/organizers/:organizerId/events/:eventId/codes":
    "members of that organizer within their event limit; another event answers 404 (test/quests/codes)",
  "POST /v1/organizers/:organizerId/events/:eventId/quests/:questId/qr/regenerate":
    "a quest of the path's event only; another event's quest answers 404 (test/quests/codes)",
  "POST /v1/quests/:questId/complete":
    "a player's own bearer session only; the database writes for the player of the request, never an argument (test/completions/complete, test/db/completion-engine)",
  "POST /v1/staff/password":
    "changes only the caller's own password, after their current one (test/auth/password-reset)",
  "GET /v1/events/:eventId/ranking":
    "a player with an active enrollment in that event only; the definers read the caller from the session, never an argument (test/ranking/ranking, test/db/ranking)",
  "PUT /v1/organizers/:organizerId/events/:eventId/ranking":
    "the organizer's owner only, for an event of that organizer; another organizer's event answers 404 (test/ranking/ranking)",
  "GET /v1/me":
    "the bearer's own profile only; the player comes from the session (test/players/profile)",
  "GET /v1/public/events":
    "no tenant data: public events that list themselves, through public_events with named columns only (test/join/join, test/db/join)",
  "GET /v1/public/events/:joinCode":
    "one event's card by its code, the secret that grants it; no organizer or player data; wrong codes are throttled (test/join/join, test/db/join)",
  "GET /v1/public/events/:joinCode/quests":
    "public and unlisted events' visible quests by named columns, never type_config; a private event answers members_only (test/join/join, test/db/join)",
  "POST /v1/join":
    "enrolls only the bearer, through join_event bound to the session; nobody inserts an enrollment directly (test/join/join, test/db/join)",
  "GET /v1/me/events":
    "the bearer's own enrollments only, read under row-level security (test/join/join)",
  "POST /v1/events/:eventId/leave":
    "leaves only the bearer's own enrollment, read and written under row-level security (test/join/leave)",
  "GET /v1/events/:eventId/home":
    "the bearer's own enrollment in that event only, read under row-level security; strangers and former members answer not_enrolled whether or not the event exists (test/home/home)",
  "GET /v1/events/:eventId/quests":
    "an active member of that event only, through member_event_quests bound to the session; named columns, never type_config (test/home/home, test/db/event-home)",
  "PUT /v1/organizers/:organizerId/events/:eventId/focus":
    "members of that organizer within their event limit; only a quest of the path's event, another answers 404; audited (test/home/home, test/db/event-home)",
  "GET /v1/organizers/:organizerId/events/:eventId/players":
    "members of that organizer within their event limit, through event_players with the join card's columns; another event answers an empty list (test/moderation/moderation, test/db/bans)",
  "PUT /v1/organizers/:organizerId/events/:eventId/players/:enrollmentId/ban":
    "the organizer's owner only, for an enrollment of the path's event; set_enrollment_ban checks again and audits (test/moderation/moderation, test/db/bans)",
  "GET /v1/organizers/:organizerId/events/:eventId/exclusions":
    "members of that organizer within their event limit; phones masked for every seat; another event answers 404 (test/moderation/moderation)",
  "POST /v1/organizers/:organizerId/events/:eventId/exclusions":
    "the organizer's owner only, for the path's event; add_exclusion checks again and audits the kind, never the value (test/moderation/moderation, test/db/bans)",
  "DELETE /v1/organizers/:organizerId/events/:eventId/exclusions/:exclusionId":
    "the organizer's owner only; another event's or organizer's entry answers 404 (test/moderation/moderation, test/db/bans)",
  "POST /v1/me/contact/code":
    "starts a change for the bearer only; start_contact_change is bound to the session and never says whether another account has the contact (test/players/contact, test/db/contact-change)",
  "POST /v1/me/contact/verify":
    "changes the bearer's own contact only, through confirm_contact_change bound to the session (test/players/contact, test/db/contact-change)",
  "POST /v1/me/acceptances":
    "records the bearer's own acceptances only, through accept_player_documents bound to the session (test/players/legal, test/db/player-legal)",
  "PATCH /v1/me":
    "the bearer's own avatar and username only; renames go through rename_player, bound to the session (test/players/profile, test/db/usernames)",
  "POST /v1/auth/code":
    "player sign-in; opens a challenge for the contact in the body, the same answer for every contact (test/players/sign-in)",
  "POST /v1/auth/resend": "bound to its own challenge token (test/players/sign-in)",
  "POST /v1/auth/verify":
    "bound to its own challenge token and code; the player comes from the database (test/players/sign-in)",
  "POST /v1/auth/signup": "bound to the signup token a verified code made (test/players/sign-in)",
  "POST /v1/auth/refresh": "bound to the refresh token's own family (test/players/sign-in)",
  "POST /v1/auth/logout": "ends only the presented refresh token's family (test/players/sign-in)",
};

const PUBLIC_ROUTES = [
  "GET /healthz",
  "GET /readyz",
  "GET /v1/config",
  "GET /v1/public/events",
  "GET /v1/public/events/:joinCode",
  "GET /v1/public/events/:joinCode/quests",
  "GET /v1/translations",
  "POST /v1/auth/code",
  "POST /v1/auth/logout",
  "POST /v1/auth/refresh",
  "POST /v1/auth/resend",
  "POST /v1/auth/signup",
  "POST /v1/auth/verify",
  "POST /v1/staff/auth/code",
  "POST /v1/staff/auth/password",
  "POST /v1/staff/auth/resend",
  "POST /v1/staff/auth/reset/confirm",
  "POST /v1/staff/auth/reset/request",
  "POST /v1/staff/auth/sign-up",
  "POST /v1/staff/auth/sign-up/code",
  "POST /v1/staff/auth/sign-up/resend",
  "POST /v1/staff/invites/accept-new",
  "POST /v1/staff/invites/inspect",
];

const MISSING = "00000000-0000-4000-8000-000000000000";

/** An error answer without its request id, which differs on every request. */
const shape = (body: string) => {
  const { requestId: _requestId, ...rest } = JSON.parse(body) as Record<string, unknown>;
  return rest;
};

describe.skipIf(TEST_DATABASE_URL === undefined)("route isolation", () => {
  let db: TestDatabase;
  let test: TestApp;
  let ids: Awaited<ReturnType<typeof seedTwoTenants>>;

  beforeAll(async () => {
    db = await createTestDatabase();
    ids = await seedTwoTenants(db.owner);
    test = await startApp(db);
  });
  afterAll(async () => {
    await test.close();
    await db.close();
  });

  const routes = (access?: "public" | "staff" | "member" | "owner") =>
    test.app.routeInventory.filter(
      (route) => route.method !== "HEAD" && (access === undefined || route.access === access),
    );

  const call = async (
    route: { method: string; url: string },
    organizerId: string,
    cookie: string,
  ): Promise<LightMyRequestResponse> =>
    test.app.inject({
      method: route.method as "GET" | "POST" | "PATCH" | "DELETE",
      url: route.url.replace(":organizerId", organizerId).replace(/:[a-zA-Z]+/g, MISSING),
      headers: withSession(cookie),
      ...(route.method === "GET" ? {} : { payload: {} }),
    });

  const sessionIdsOf = async (staffUserId: string): Promise<string[]> =>
    (
      await db.owner.query<{ id: string }>(
        "SELECT id FROM staff_session WHERE staff_user_id = $1 AND revoked_at IS NULL",
        [staffUserId],
      )
    ).rows.map((row) => row.id);

  const stillSignedIn = async (cookie: string) =>
    (await test.app.inject({ url: "/v1/staff/me", headers: withSession(cookie) })).statusCode;

  describe("every route is accounted for", () => {
    it("lists each route with how it keeps callers apart", () => {
      expect(
        routes()
          .map((route) => `${route.method} ${route.url}`)
          .toSorted(),
      ).toEqual(Object.keys(ROUTES).toSorted());
    });

    it("has exactly these public routes and nothing else open", () => {
      expect(
        routes("public")
          .map((route) => `${route.method} ${route.url}`)
          .toSorted(),
      ).toEqual(PUBLIC_ROUTES);
    });

    it("keeps staff routes under /v1/staff, where the session check runs", () => {
      for (const route of routes("staff")) {
        expect(route.url.startsWith("/v1/staff/"), route.url).toBe(true);
      }
    });
  });

  describe("outsider (no session)", () => {
    it("answers 401 with no-store on every staff route", async () => {
      const closed = [...routes("staff"), ...routes("member"), ...routes("owner")];
      expect(closed.length).toBeGreaterThanOrEqual(4);
      for (const route of closed) {
        const response = await test.app.inject({
          method: route.method as "GET" | "POST" | "DELETE",
          url: route.url.replace(":id", MISSING).replace(":organizerId", MISSING),
          headers: browserHeaders(),
        });
        expect(response.statusCode, `${route.method} ${route.url}`).toBe(401);
        expect(response.headers["cache-control"]).toBe("no-store");
      }
    });

    it("cannot tell another organizer's private event from one that does not exist", async () => {
      const hidden = await test.app.inject({ url: `/v1/config?event=${ids.eventB}` });
      const missing = await test.app.inject({ url: `/v1/config?event=${MISSING}` });
      expect(hidden.statusCode).toBe(404);
      expect(missing.statusCode).toBe(404);
      expect(shape(hidden.body)).toEqual(shape(missing.body));
    });
  });

  describe("one staff member against another", () => {
    let cookieA = "";
    let cookieB = "";
    let staffA = "";
    let staffB = "";

    beforeAll(async () => {
      staffA = await createStaff(db.owner, { email: "owner@najd.test" });
      staffB = await createStaff(db.owner, { email: "owner@tabuk.test" });
      await db.owner.query(
        "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, 'owner'), ($3, $4, 'owner')",
        [ids.orgA, staffA, ids.orgB, staffB],
      );
      cookieA = await signInFully(test, "owner@najd.test");
      cookieB = await signInFully(test, "owner@tabuk.test");
    });

    it("shows A only A's account and organizer", async () => {
      const me = await test.app.inject({ url: "/v1/staff/me", headers: withSession(cookieA) });
      expect(me.statusCode).toBe(200);
      const body = me.json<{ id: string; memberships: { organizerId: string }[] }>();
      expect(body.id).toBe(staffA);
      expect(body.memberships.map((membership) => membership.organizerId)).toEqual([ids.orgA]);
      expect(me.body).not.toContain(staffB);
      expect(me.body).not.toContain(ids.orgB);
    });

    it("lists only A's own sessions", async () => {
      const list = await test.app.inject({
        url: "/v1/staff/sessions",
        headers: withSession(cookieA),
      });
      expect(list.statusCode).toBe(200);
      const listed = list.json<{ sessions: { id: string }[] }>().sessions.map((s) => s.id);
      expect(listed.toSorted()).toEqual((await sessionIdsOf(staffA)).toSorted());
      for (const id of await sessionIdsOf(staffB)) {
        expect(list.body).not.toContain(id);
      }
    });

    it("cannot end B's session: 404 like a missing one, and B stays signed in", async () => {
      const [sessionB] = await sessionIdsOf(staffB);
      expect(sessionB).toBeDefined();
      const attempt = await test.app.inject({
        method: "DELETE",
        url: `/v1/staff/sessions/${sessionB}`,
        headers: withSession(cookieA),
      });
      const missing = await test.app.inject({
        method: "DELETE",
        url: `/v1/staff/sessions/${MISSING}`,
        headers: withSession(cookieA),
      });
      expect(attempt.statusCode).toBe(404);
      expect(missing.statusCode).toBe(404);
      expect(shape(attempt.body)).toEqual(shape(missing.body));
      expect(await stillSignedIn(cookieB)).toBe(200);
    });

    it("signing out ends only A's own session", async () => {
      const out = await test.app.inject({
        method: "POST",
        url: "/v1/staff/auth/sign-out",
        headers: withSession(cookieA),
      });
      expect(out.statusCode).toBe(204);
      expect(await stillSignedIn(cookieA)).toBe(401);
      expect(await stillSignedIn(cookieB)).toBe(200);
    });
  });

  describe("organizer routes", () => {
    let ownerCookie = "";
    let editorCookie = "";
    let strangerCookie = "";

    beforeAll(async () => {
      const ownerId = await createStaff(db.owner, { email: "boss@najd-team.test" });
      const editorId = await createStaff(db.owner, { email: "editor@najd-team.test" });
      const strangerId = await createStaff(db.owner, { email: "boss@tabuk-team.test" });
      const org = (
        await db.owner.query<{ id: string }>(
          "INSERT INTO organizer (name, slug) VALUES ('Team Co', 'team-co') RETURNING id",
        )
      ).rows[0]?.id;
      await db.owner.query(
        "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'editor'), ($4, $5, 'editor')",
        [org, ownerId, editorId, ids.orgB, strangerId],
      );
      organizerOfTeam = org ?? "";
      ownerCookie = await signInFully(test, "boss@najd-team.test");
      editorCookie = await signInFully(test, "editor@najd-team.test");
      strangerCookie = await signInFully(test, "boss@tabuk-team.test");
    });

    let organizerOfTeam = "";

    it("declares every route under /v1/organizers as member or owner", () => {
      const organizerRoutes = routes().filter((route) => route.url.startsWith("/v1/organizers/"));
      expect(organizerRoutes.length).toBeGreaterThan(0);
      for (const route of organizerRoutes) {
        expect(["member", "owner"], `${route.method} ${route.url}`).toContain(route.access);
      }
    });

    it("answers a member of another organizer exactly like a missing organizer: 404", async () => {
      for (const route of [...routes("member"), ...routes("owner")]) {
        const other = await call(route, organizerOfTeam, strangerCookie);
        const missing = await call(route, MISSING, strangerCookie);
        expect(other.statusCode, `${route.method} ${route.url}`).toBe(404);
        expect(shape(other.body)).toEqual(shape(missing.body));
        const malformed = await call(route, "not-a-uuid", strangerCookie);
        expect(malformed.statusCode).toBe(404);
      }
    });

    it("refuses an editor every owner route with 403", async () => {
      for (const route of routes("owner")) {
        const response = await call(route, organizerOfTeam, editorCookie);
        expect(response.statusCode, `${route.method} ${route.url}`).toBe(403);
        expect(response.json()).toMatchObject({ code: "owner_only" });
      }
    });

    it("shows the team to its members, owner first, with emails and no other account fields", async () => {
      for (const cookie of [ownerCookie, editorCookie]) {
        const response = await test.app.inject({
          url: `/v1/organizers/${organizerOfTeam}/members`,
          headers: withSession(cookie),
        });
        expect(response.statusCode).toBe(200);
        expect(response.headers["cache-control"]).toBe("no-store");
        const body = response.json<{
          members: { email: string; role: string }[];
          invites: unknown[];
        }>();
        expect(body.members.map((member) => [member.email, member.role])).toEqual([
          ["boss@najd-team.test", "owner"],
          ["editor@najd-team.test", "editor"],
        ]);
        expect(response.body).not.toContain("argon2");
        expect(response.body).not.toContain("tabuk");
      }
    });
  });
});
