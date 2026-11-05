import { createHash, randomBytes, randomUUID } from "node:crypto";
import { DEFAULT_TERMS } from "@questify/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PublicAccount } from "#src/auth/staff-store";
import { door } from "#src/console/doors";
import { HttpError } from "#src/http-error";
import { supportSeatOf } from "#src/organizers/support-seat";
import {
  createStaff,
  signInFully,
  startApp,
  withSession,
  type TestApp,
} from "#test/support/auth-app";
import { TEST_DATABASE_URL, createTestDatabase, type TestDatabase } from "#test/support/test-db";

type Row = Record<string, unknown>;
type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

const granted = (grantId: string, eventId: string) => [
  { grantId, eventId, expiresAt: expect.any(Date) as Date, kind: "edit" },
];
const coded = (code: string) => Object.assign(new Error(code), { code });

/**
 * The console's organizers, suspension and support access over HTTP (T-701): admin-only reads audited with ids only,
 * suspended organizers and events read-only to their team and unavailable to players, and the support seat's
 * deny-by-default route list.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("console organizers over HTTP", () => {
  let db: TestDatabase;
  let test: TestApp;
  let orgA: string;
  let orgB: string;
  let eventA: string;
  let eventA2: string;
  let eventB: string;
  let eventBDraft: string;
  let ownerCookie: string;
  let adminCookie: string;
  let strangerCookie: string;
  let playerToken: string;

  const owner = async <T extends Row>(sql: string, values: unknown[] = []) =>
    (await db.owner.query<T>(sql, values)).rows;
  const newEvent = async (organizer: string, code: string) =>
    (
      await owner<{ id: string }>(
        `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at)
         VALUES ($1, $2, 'Fest', 'live', now() - interval '1 hour', now() + interval '2 days') RETURNING id`,
        [organizer, code],
      )
    )[0]?.id ?? "";

  beforeAll(async () => {
    db = await createTestDatabase();
    test = await startApp(db);
    const orgs = await owner<{ id: string }>(
      "INSERT INTO organizer (name, slug) VALUES ('Najd Events', 'najd'), ('Tabuk Fest', 'tabuk') RETURNING id",
    );
    orgA = orgs[0]?.id ?? "";
    orgB = orgs[1]?.id ?? "";
    eventA = await newEvent(orgA, "CONA1");
    eventA2 = await newEvent(orgA, "CONA2");
    eventB = await newEvent(orgB, "CONB1");
    eventBDraft =
      (
        await owner<{ id: string }>(
          `INSERT INTO event (organizer_id, join_code, name_en, status)
           VALUES ($1, 'CONB2', 'Draft Fest', 'draft') RETURNING id`,
          [orgB],
        )
      )[0]?.id ?? "";
    const ownerId = await createStaff(db.owner, { email: "owner@najd.test" });
    const ownerB = await createStaff(db.owner, { email: "owner@tabuk.test" });
    await createStaff(db.owner, { email: "admin@questify.test", admin: true });
    await createStaff(db.owner, { email: "stranger@najd.test" });
    await owner(
      "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, 'owner'), ($3, $4, 'owner')",
      [orgA, ownerId, orgB, ownerB],
    );
    ownerCookie = await signInFully(test, "owner@najd.test");
    adminCookie = await signInFully(test, "admin@questify.test");
    strangerCookie = await signInFully(test, "stranger@najd.test");
    const [player] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ('console_player') RETURNING id",
    );
    await owner("INSERT INTO enrollment (organizer_id, event_id, player_id) VALUES ($1, $2, $3)", [
      orgA,
      eventA,
      player?.id,
    ]);
    playerToken = randomBytes(32).toString("base64url");
    await owner(
      "INSERT INTO player_session (player_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
      [player?.id, createHash("sha256").update(playerToken).digest()],
    );
  });
  afterAll(async () => {
    await test.close();
    await db.close();
  });

  const call = (method: Method, url: string, cookie: string, payload?: object) =>
    test.app.inject({
      method,
      url,
      headers: withSession(cookie, { "idempotency-key": randomUUID() }),
      ...(payload === undefined ? {} : { payload }),
    });
  const team = (method: Method, path: string, cookie = ownerCookie, payload?: object) =>
    call(method, `/v1/organizers/${orgA}${path}`, cookie, payload);
  const reason = "Reported fraud at the prize desk";
  const lastAudit = async (action: string) =>
    (
      await owner<{ actor_type: string; target_id: string | null; after: unknown }>(
        "SELECT actor_type, target_id, after FROM audit_log WHERE action = $1 ORDER BY id DESC LIMIT 1",
        [action],
      )
    )[0];

  describe("reads", () => {
    it("answer 404 to anyone but an admin", async () => {
      for (const cookie of [ownerCookie, strangerCookie]) {
        expect((await call("GET", "/v1/admin/organizers", cookie)).statusCode).toBe(404);
        expect((await call("GET", `/v1/admin/organizers/${orgA}`, cookie)).statusCode).toBe(404);
        expect(
          (
            await call("POST", `/v1/admin/events/${eventA}/support`, cookie, {
              kind: "edit",
              reason,
            })
          ).statusCode,
        ).toBe(404);
      }
    });

    it("search by name or slug prefix and by owner email exactly, audited with ids only", async () => {
      const ids = async (query: string) =>
        (await call("GET", `/v1/admin/organizers${query}`, adminCookie))
          .json<{ organizers: { id: string }[] }>()
          .organizers.map((row) => row.id);
      expect(await ids("?q=NAJ")).toEqual([orgA]);
      expect(await ids("?q=tab")).toEqual([orgB]);
      expect(await ids("?q=owner%40najd.test")).toEqual([orgA]);
      expect(await ids("?q=owner%40naj")).toEqual([]);
      expect(await ids("")).toEqual([orgA, orgB]);
      const first = await call("GET", "/v1/admin/organizers?limit=1", adminCookie);
      expect(first.json()).toMatchObject({
        organizers: [{ id: orgA, ownerEmail: "owner@najd.test", events: { live: 2 } }],
        nextCursor: orgA,
      });
      expect(await ids(`?cursor=${orgA}`)).toEqual([orgB]);
      expect(await lastAudit("console.organizers_read")).toMatchObject({
        actor_type: "admin",
        after: { organizerIds: [orgB] },
      });
    });

    it("show one organizer and one event, each read audited", async () => {
      const detail = await call("GET", `/v1/admin/organizers/${orgA}`, adminCookie);
      expect(detail.statusCode).toBe(200);
      expect(detail.json()).toMatchObject({
        organizer: { id: orgA, status: "active", suspension: null },
        team: [{ email: "owner@najd.test", role: "owner" }],
      });
      expect(await lastAudit("console.organizer_read")).toMatchObject({ target_id: orgA });
      expect(
        (await call("GET", `/v1/admin/organizers/${randomUUID()}`, adminCookie)).statusCode,
      ).toBe(404);
      const event = await call("GET", `/v1/admin/events/${eventA}`, adminCookie);
      expect(event.json()).toMatchObject({
        event: { event: { suspension: null, organizerSuspension: null }, supportGrants: [] },
      });
      expect(await lastAudit("console.event_read")).toMatchObject({ target_id: eventA });
    });
  });

  describe("suspension", () => {
    it("makes an event read-only to its team and unavailable to players, then restores it", async () => {
      const suspendPath = `/v1/admin/events/${eventA}/suspend`;
      const short = await call("POST", suspendPath, adminCookie, { reason: "short" });
      expect(short.json()).toMatchObject({ code: "invalid_reason" });
      expect((await call("POST", suspendPath, adminCookie, { reason })).statusCode).toBe(200);
      expect((await call("POST", suspendPath, adminCookie, { reason })).statusCode).toBe(409);
      expect((await team("GET", `/events/${eventA}`)).statusCode).toBe(200);
      const write = await team("PUT", `/events/${eventA}/terms`, ownerCookie, {});
      expect(write.statusCode).toBe(423);
      expect(write.json()).toMatchObject({ code: "event_suspended" });
      expect((await team("PUT", `/events/${eventA2}/terms`, ownerCookie, {})).statusCode).toBe(200);
      const home = await test.app.inject({
        method: "GET",
        url: `/v1/events/${eventA}/home`,
        headers: { authorization: `Bearer ${playerToken}` },
      });
      expect(home.statusCode).toBe(404);
      expect(home.json()).toMatchObject({ code: "event_unavailable" });
      const view = await call("GET", `/v1/admin/events/${eventA}`, adminCookie);
      expect(view.json()).toMatchObject({ event: { event: { suspension: { reason } } } });
      const lift = await call("POST", `/v1/admin/events/${eventA}/reactivate`, adminCookie);
      expect(lift.statusCode).toBe(204);
      expect((await team("PUT", `/events/${eventA}/terms`, ownerCookie, {})).statusCode).toBe(200);
    });

    it("makes a whole organizer read-only to its team, and shows the team the reason", async () => {
      const path = `/v1/admin/organizers/${orgA}`;
      expect((await call("POST", `${path}/suspend`, adminCookie, { reason })).statusCode).toBe(200);
      const write = await team("PUT", `/events/${eventA2}/terms`, ownerCookie, {});
      expect(write.json()).toMatchObject({ code: "organizer_suspended" });
      const me = await call("GET", "/v1/staff/me", ownerCookie);
      expect(me.json()).toMatchObject({
        memberships: [{ organizerId: orgA, suspension: { reason } }],
      });
      expect((await call("POST", `${path}/reactivate`, adminCookie)).statusCode).toBe(204);
      expect((await call("POST", `${path}/reactivate`, adminCookie)).statusCode).toBe(409);
      expect((await team("PUT", `/events/${eventA2}/terms`, ownerCookie, {})).statusCode).toBe(200);
    });
  });

  describe("the team while suspended", () => {
    it("can still leave and remove a member, so a compromised account is cut off, and nothing else", async () => {
      const [editorId, otherId] = [
        await createStaff(db.owner, { email: "editor@najd.test" }),
        await createStaff(db.owner, { email: "other.editor@najd.test" }),
      ];
      await owner(
        "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, 'editor'), ($1, $3, 'editor')",
        [orgA, editorId, otherId],
      );
      const editorCookie = await signInFully(test, "editor@najd.test");
      const path = `/v1/admin/organizers/${orgA}`;
      expect((await call("POST", `${path}/suspend`, adminCookie, { reason })).statusCode).toBe(200);
      const refused: ReadonlyArray<readonly [Method, string]> = [
        ["POST", "/invites"],
        ["POST", "/ownership"],
        ["DELETE", `/invites/${randomUUID()}`],
        ["PATCH", `/members/${otherId}`],
        ["POST", "/events"],
      ];
      for (const [method, route] of refused) {
        const answer = await team(method, route, ownerCookie, {});
        expect(answer.statusCode, `${method} ${route}`).toBe(423);
        expect(answer.json()).toMatchObject({ code: "organizer_suspended" });
      }
      expect((await team("DELETE", "/members/me", editorCookie)).statusCode).toBe(204);
      expect((await team("DELETE", `/members/${otherId}`)).statusCode).toBe(204);
      const left = await owner<{ staff_user_id: string }>(
        "SELECT staff_user_id FROM organizer_member WHERE organizer_id = $1 AND role = 'editor'",
        [orgA],
      );
      expect(left).toEqual([]);
      expect(
        (await call("POST", `${path}/reactivate`, adminCookie, { reason: "short" })).statusCode,
      ).toBe(400);
      const lifted = await call("POST", `${path}/reactivate`, adminCookie, {
        reason: "Fraud case closed by finance",
      });
      expect(lifted.statusCode).toBe(204);
      expect(await lastAudit("organizer.reactivate")).toMatchObject({
        actor_type: "admin",
        after: { reason: "Fraud case closed by finance" },
      });
    });

    it("records no reason on a reactivation that gives none", async () => {
      const path = `/v1/admin/events/${eventA2}`;
      await call("POST", `${path}/suspend`, adminCookie, { reason });
      expect((await call("POST", `${path}/reactivate`, adminCookie)).statusCode).toBe(204);
      expect(await lastAudit("event.reactivate")).toMatchObject({ after: null });
    });
  });

  describe("the support seat", () => {
    it("opens one event as an editor, refuses everything else, and closes", async () => {
      expect((await team("GET", `/events/${eventA}`, adminCookie)).statusCode).toBe(404);
      const opened = await call("POST", `/v1/admin/events/${eventA}/support`, adminCookie, {
        kind: "edit",
        reason,
      });
      expect(opened.statusCode).toBe(201);
      const grant = opened.json<{ grant: { grantId: string } }>().grant.grantId;
      const me = await call("GET", "/v1/staff/me", adminCookie);
      expect(me.json()).toMatchObject({
        memberships: [
          {
            organizerId: orgA,
            role: "editor",
            eventScope: [eventA],
            support: [{ eventId: eventA }],
          },
        ],
      });
      expect((await team("GET", `/events/${eventA}`, adminCookie)).statusCode).toBe(200);
      const list = await team("GET", "/events", adminCookie);
      expect(list.statusCode).toBe(200);
      expect(JSON.stringify(list.json())).not.toContain(eventA2);
      const gems = {
        ...DEFAULT_TERMS,
        currency: {
          icon: "gem",
          ar: { one: "جوهرة", many: "جواهر" },
          en: { one: "gem", many: "gems" },
        },
      };
      expect((await team("PUT", `/events/${eventA}/terms`, adminCookie, gems)).statusCode).toBe(
        200,
      );
      expect(
        (
          await owner(
            "SELECT 1 FROM audit_log WHERE support_grant_id = $1 AND actor_type = 'staff' AND event_id = $2",
            [grant, eventA],
          )
        ).length,
      ).toBeGreaterThan(0);
      for (const [method, path] of [
        ["GET", `/events/${eventA2}`],
        ["GET", "/members"],
        ["GET", "/alerts/me"],
        ["DELETE", "/members/me"],
        ["POST", "/events"],
        ["POST", `/events/${eventA}/devices`],
        ["POST", `/events/${eventA}/devices/preview`],
        ["POST", `/events/${eventA}/exports/players`],
      ] as const) {
        expect((await team(method, path, adminCookie, {})).statusCode, `${method} ${path}`).toBe(
          404,
        );
      }
      expect((await team("POST", `/events/${eventA}/activation`, adminCookie)).statusCode).toBe(
        403,
      );
      expect(
        (await call("GET", `/v1/organizers/${orgB}/events/${eventB}`, adminCookie)).statusCode,
      ).toBe(404);
      const view = await call("GET", `/v1/admin/events/${eventA}`, adminCookie);
      expect(view.json()).toMatchObject({
        event: { supportGrants: [{ id: grant, mine: true, adminEmail: "admin@questify.test" }] },
      });
      expect((await call("POST", `/v1/admin/support/${grant}/close`, adminCookie)).statusCode).toBe(
        204,
      );
      expect((await call("POST", `/v1/admin/support/${grant}/close`, adminCookie)).statusCode).toBe(
        404,
      );
      expect((await team("GET", `/events/${eventA}`, adminCookie)).statusCode).toBe(404);
    });

    it("keeps writing while the event is suspended (Q-377), and ends at expiry", async () => {
      const opened = await call("POST", `/v1/admin/events/${eventA}/support`, adminCookie, {
        kind: "edit",
        reason,
      });
      const grant = opened.json<{ grant: { grantId: string } }>().grant.grantId;
      await call("POST", `/v1/admin/events/${eventA}/suspend`, adminCookie, { reason });
      expect((await team("PUT", `/events/${eventA}/terms`, adminCookie, {})).statusCode).toBe(200);
      expect((await team("PUT", `/events/${eventA}/terms`, ownerCookie, {})).statusCode).toBe(423);
      await call("POST", `/v1/admin/events/${eventA}/reactivate`, adminCookie);
      await owner(
        `UPDATE support_grant SET opened_at = opened_at - interval '20 minutes',
                                  expires_at = expires_at - interval '20 minutes' WHERE id = $1`,
        [grant],
      );
      expect((await team("GET", `/events/${eventA}`, adminCookie)).statusCode).toBe(404);
    });

    it("refuses a member admin and a short reason", async () => {
      const short = await call("POST", `/v1/admin/events/${eventA}/support`, adminCookie, {
        kind: "edit",
        reason: "short",
      });
      expect(short.json()).toMatchObject({ code: "invalid_reason" });
      expect(
        (
          await call("POST", `/v1/admin/events/${randomUUID()}/support`, adminCookie, {
            kind: "edit",
            reason,
          })
        ).statusCode,
      ).toBe(404);
    });
  });

  const adminId = async (email = "admin@questify.test") =>
    (await owner<{ id: string }>("SELECT id FROM staff_user WHERE email = $1", [email]))[0]?.id ??
    "";
  const openSupportOn = async (eventId: string) =>
    (
      await call("POST", `/v1/admin/events/${eventId}/support`, adminCookie, {
        kind: "edit",
        reason,
      })
    ).json<{
      grant: { grantId: string };
    }>().grant.grantId;
  const closeSupportOf = (grantId: string) =>
    call("POST", `/v1/admin/support/${grantId}/close`, adminCookie);
  const organizers = async (query: string) =>
    (await call("GET", `/v1/admin/organizers${query}`, adminCookie)).json<{
      organizers: { id: string }[];
      nextCursor: string | null;
    }>();
  const fillTo = (bucket: string, total: number) =>
    owner(
      `INSERT INTO auth_throttle (bucket, key, at)
       SELECT t.bucket, t.key, clock_timestamp()
       FROM (SELECT DISTINCT bucket, key FROM auth_throttle WHERE bucket = $1) t, generate_series(2, $2)`,
      [bucket, total],
    );
  const suspendedAtOf = async (table: "organizer" | "event", id: string) =>
    (
      await owner<{ at: Date }>(`SELECT suspended_at AS at FROM ${table} WHERE id = $1`, [id])
    )[0]?.at.toISOString();

  describe("supportSeatOf", () => {
    it("is an editor seat on the granted events of that organizer and of no other", async () => {
      const grantA = await openSupportOn(eventA);
      const grantB = await openSupportOn(eventB);
      const account: PublicAccount = {
        id: await adminId(),
        email: "admin@questify.test",
        status: "active",
        platformRole: "admin",
      };
      expect(await supportSeatOf(test.pool, account, orgA)).toEqual({
        id: orgA,
        role: "editor",
        eventScope: [eventA],
        suspension: null,
        support: granted(grantA, eventA),
      });
      expect(await supportSeatOf(test.pool, account, orgB)).toEqual({
        id: orgB,
        role: "editor",
        eventScope: [eventB],
        suspension: null,
        support: granted(grantB, eventB),
      });
      expect(await supportSeatOf(test.pool, account, randomUUID())).toBeUndefined();
      await closeSupportOf(grantA);
      expect(await supportSeatOf(test.pool, account, orgA)).toBeUndefined();
      expect(await supportSeatOf(test.pool, account, orgB)).toMatchObject({ id: orgB });
      await closeSupportOf(grantB);
    });

    it("gives nothing to an account that is not an active platform admin", async () => {
      const grant = await openSupportOn(eventA);
      const account: PublicAccount = {
        id: await adminId(),
        email: "admin@questify.test",
        status: "active",
        platformRole: "admin",
      };
      expect(await supportSeatOf(test.pool, account, orgA)).toMatchObject({ id: orgA });
      const notAdmin = { ...account, platformRole: "none" as const };
      const disabled = { ...account, status: "disabled" as const };
      const neither = { ...notAdmin, status: "disabled" as const };
      for (const refused of [notAdmin, disabled, neither]) {
        expect(await supportSeatOf(test.pool, refused, orgA)).toBeUndefined();
      }
      await closeSupportOf(grant);
    });
  });

  describe("the console door", () => {
    it("rethrows what is not one of its refusals, unchanged", async () => {
      const admin = { id: await adminId() };
      const strangers = [
        new Error("plain"),
        Object.assign(new Error("unknown code"), { code: "XX000" }),
        Object.assign(new Error("inherited key"), { code: "toString" }),
        Object.assign(new Error("inherited key"), { code: "constructor" }),
        Object.assign(new Error("number, not text"), { code: 23505 }),
      ];
      for (const error of strangers) {
        await expect(door(test.pool, admin, () => Promise.reject(error))).rejects.toBe(error);
      }
    });

    it("answers one of its own codes as the matching HttpError", async () => {
      const admin = { id: await adminId() };
      const notFound = await door(test.pool, admin, () => Promise.reject(coded("QE403"))).catch(
        (error: unknown) => error,
      );
      expect(notFound).toBeInstanceOf(HttpError);
      expect(notFound).toMatchObject({ status: 404 });
      const busy = await door(test.pool, admin, () => Promise.reject(coded("23505"))).catch(
        (error: unknown) => error,
      );
      expect(busy).toBeInstanceOf(HttpError);
    });
  });

  describe("a suspended organizer in the console", () => {
    it("answers when it was suspended, and shows the suspension, events and history", async () => {
      const orgPath = `/v1/admin/organizers/${orgB}`;
      const eventPath = `/v1/admin/events/${eventB}`;
      const orgAnswer = await call("POST", `${orgPath}/suspend`, adminCookie, { reason });
      const orgSince = await suspendedAtOf("organizer", orgB);
      expect(orgAnswer.json()).toEqual({ suspendedAt: orgSince });
      const eventAnswer = await call("POST", `${eventPath}/suspend`, adminCookie, { reason });
      const eventSince = await suspendedAtOf("event", eventB);
      expect(eventAnswer.json()).toEqual({ suspendedAt: eventSince });
      const [fest] = await owner<{ starts_at: Date; ends_at: Date }>(
        "SELECT starts_at, ends_at FROM event WHERE id = $1",
        [eventB],
      );
      const history = (
        await owner<{
          id: string;
          at: Date;
          actor_type: string;
          action: string;
          target_type: string;
          event_id: string | null;
        }>(
          `SELECT id::text, at, actor_type, action, target_type, event_id FROM audit_log
           WHERE organizer_id = $1 ORDER BY audit_log.id DESC LIMIT 50`,
          [orgB],
        )
      ).map((row) => ({
        id: row.id,
        at: row.at.toISOString(),
        actorType: row.actor_type,
        action: row.action,
        targetType: row.target_type,
        eventId: row.event_id,
        bySupport: false,
      }));

      const detail = (await call("GET", orgPath, adminCookie)).json<{
        organizer: object;
        events: object[];
        history: object[];
      }>();

      expect(detail.organizer).toMatchObject({
        id: orgB,
        status: "paused",
        suspension: { reason, since: orgSince },
      });
      expect(detail.events).toEqual([
        {
          id: eventBDraft,
          joinCode: "CONB2",
          name: { ar: null, en: "Draft Fest" },
          status: "draft",
          statusNow: "draft",
          startsAt: null,
          endsAt: null,
          suspension: null,
        },
        {
          id: eventB,
          joinCode: "CONB1",
          name: { ar: null, en: "Fest" },
          status: "live",
          statusNow: "live",
          startsAt: fest?.starts_at.toISOString(),
          endsAt: fest?.ends_at.toISOString(),
          suspension: { reason, since: eventSince },
        },
      ]);
      expect(history.length).toBeGreaterThanOrEqual(2);
      expect(history[0]).toMatchObject({ action: "event.suspend", eventId: eventB });
      expect(detail.history).toEqual(history);

      expect((await organizers("?status=paused")).organizers.map((row) => row.id)).toEqual([orgB]);
      expect((await organizers("?status=active")).organizers.map((row) => row.id)).toEqual([orgA]);
      expect((await call("POST", `${eventPath}/reactivate`, adminCookie)).statusCode).toBe(204);
      expect((await call("POST", `${orgPath}/reactivate`, adminCookie)).statusCode).toBe(204);
    });

    it("gives a cursor only for a full page", async () => {
      expect((await organizers("")).nextCursor).toBeNull();
      expect((await organizers("?limit=3")).nextCursor).toBeNull();
      expect((await organizers("?limit=2")).nextCursor).toBe(orgB);
    });
  });

  describe("an organizer's history", () => {
    it("lists the newest entries first by number, across ids that gain a digit", async () => {
      await owner(
        `INSERT INTO audit_log (id, actor_type, organizer_id, action, target_type)
           OVERRIDING SYSTEM VALUE
         VALUES (999999999, 'system', $1, 'organizer.test_entry', 'organizer'),
                (1000000000, 'system', $1, 'organizer.test_entry', 'organizer')`,
        [orgA],
      );

      const detail = (await call("GET", `/v1/admin/organizers/${orgA}`, adminCookie)).json<{
        history: { id: string }[];
      }>();

      expect(detail.history.slice(0, 2).map((entry) => entry.id)).toEqual([
        "1000000000",
        "999999999",
      ]);
    });
  });

  describe("a suspension and the API's own cache", () => {
    it("refuses the next write at once, even right after an allowed one", async () => {
      const terms = `/events/${eventA2}/terms`;
      const path = `/v1/admin/events/${eventA2}`;
      expect((await team("PUT", terms, ownerCookie, {})).statusCode).toBe(200);
      expect((await call("POST", `${path}/suspend`, adminCookie, { reason })).statusCode).toBe(200);
      const refused = await team("PUT", terms, ownerCookie, {});
      expect(refused.statusCode).toBe(423);
      expect(refused.json()).toMatchObject({ code: "event_suspended" });
      expect((await call("POST", `${path}/reactivate`, adminCookie)).statusCode).toBe(204);
      expect((await team("PUT", terms, ownerCookie, {})).statusCode).toBe(200);
    });
  });

  describe("closing support", () => {
    it("refuses a body it does not expect and leaves the grant open", async () => {
      const grant = await openSupportOn(eventA);
      const refused = await call("POST", `/v1/admin/support/${grant}/close`, adminCookie, {
        unexpected: true,
      });
      expect(refused.statusCode).toBe(400);
      const [row] = await owner<{ closed_at: Date | null }>(
        "SELECT closed_at FROM support_grant WHERE id = $1",
        [grant],
      );
      expect(row?.closed_at).toBeNull();
      expect((await closeSupportOf(grant)).statusCode).toBe(204);
    });
  });

  describe("the console's rate limits", () => {
    const BUCKETS = "('console_organizer', 'console_suspend')";
    let secondCookie = "";
    beforeAll(async () => {
      await createStaff(db.owner, { email: "admin2@questify.test", admin: true });
      secondCookie = await signInFully(test, "admin2@questify.test");
    });
    const clear = () => owner(`DELETE FROM auth_throttle WHERE bucket IN ${BUCKETS}`);

    it("count each admin's reads and suspensions in a bucket of their own", async () => {
      await clear();
      await call("GET", "/v1/admin/organizers", adminCookie);
      await call("GET", `/v1/admin/organizers/${orgA}`, adminCookie);
      await call("GET", "/v1/admin/organizers", secondCookie);
      const path = `/v1/admin/events/${eventA2}`;
      await call("POST", `${path}/suspend`, adminCookie, { reason });
      await call("POST", `${path}/reactivate`, adminCookie);

      const perBucket = await owner(
        `SELECT bucket, count(*)::int AS n, count(DISTINCT key)::int AS keys FROM auth_throttle
         WHERE bucket IN ${BUCKETS} GROUP BY bucket ORDER BY bucket`,
      );
      expect(perBucket).toEqual([
        { bucket: "console_organizer", n: 3, keys: 2 },
        { bucket: "console_suspend", n: 2, keys: 1 },
      ]);
      const [all] = await owner<{ keys: number }>(
        `SELECT count(DISTINCT key)::int AS keys FROM auth_throttle WHERE bucket IN ${BUCKETS}`,
      );
      expect(all?.keys).toBe(3);
      await clear();
    });

    it("hold an admin back after 120 reads a minute, and not another admin", async () => {
      await clear();
      expect((await call("GET", "/v1/admin/organizers", adminCookie)).statusCode).toBe(200);
      await fillTo("console_organizer", 120);
      const held = await call("GET", "/v1/admin/organizers", adminCookie);
      expect(held.statusCode).toBe(429);
      expect(Number(held.headers["retry-after"])).toBeGreaterThanOrEqual(1);
      expect((await call("GET", `/v1/admin/organizers/${orgA}`, adminCookie)).statusCode).toBe(429);
      expect((await call("GET", "/v1/admin/organizers", secondCookie)).statusCode).toBe(200);
      await clear();
    });

    it("hold an admin back after 30 suspensions and reactivations an hour", async () => {
      await clear();
      const path = `/v1/admin/events/${eventA2}`;
      expect((await call("POST", `${path}/suspend`, adminCookie, { reason })).statusCode).toBe(200);
      await fillTo("console_suspend", 30);
      const held = await call("POST", `${path}/reactivate`, adminCookie);
      expect(held.statusCode).toBe(429);
      expect(Number(held.headers["retry-after"])).toBeGreaterThanOrEqual(1);
      expect((await call("GET", "/v1/admin/organizers", adminCookie)).statusCode).toBe(200);
      await clear();
      expect((await call("POST", `${path}/reactivate`, adminCookie)).statusCode).toBe(204);
      await clear();
    });
  });
});
