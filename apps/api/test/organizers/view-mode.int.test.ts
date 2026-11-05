import { randomUUID } from "node:crypto";
import type { LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ORGANIZER_PREFIX } from "#src/route-access";
import { seedAnalytics } from "#test/support/analytics-seed";
import {
  createStaff,
  signInConsole,
  signInFully,
  startApp,
  withSession,
  type TestApp,
} from "#test/support/auth-app";
import {
  TEST_DATABASE_URL,
  addMember,
  createTestDatabase,
  seedTwoTenants,
  type TestDatabase,
} from "#test/support/test-db";

type Row = Record<string, unknown>;
type Route = Readonly<{ method: string; url: string }>;

/** Routes support never reaches in a view (ADR-524): a 404 from the deny-by-default list, not from the handler. */
const REFUSED_IN_VIEW = ["GET /events/:eventId/codes", "GET /events/:eventId/rehearsal"];

/** A page's "as of" times differ between two reads a moment apart; everything else must match. */
const timeless = (body: string) =>
  body.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})/g, "<time>");

/** The tables whose rows differ between two snapshots. */
const changed = (before: Record<string, string>, after: Record<string, string>) =>
  Object.keys(after).filter((name) => before[name] !== after[name]);

/**
 * The view as organizer over HTTP (T-712, ADR-521 to ADR-524), generated from the app's route inventory so a new
 * organizer route is covered without editing this file: every write answers 403 `support_view_only` and changes
 * nothing; every read answers without a server error, writes nothing, and shows what an edit grant shows.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)(
  "view as organizer (every organizer route)",
  () => {
    let db: TestDatabase;
    let test: TestApp;
    let ids: Awaited<ReturnType<typeof seedTwoTenants>>;
    let eventP: string;
    let adminCookie: string;
    let supportCookie: string;
    let routes: Route[];

    const owner = async <T extends Row>(sql: string, values: unknown[] = []) =>
      (await db.owner.query<T>(sql, values)).rows;

    beforeAll(async () => {
      db = await createTestDatabase();
      test = await startApp(db);
      ids = await seedTwoTenants(db.owner);
      await addMember(db.owner, ids.orgA, "owner");
      // Before go-live, no rehearsal opened yet: a first read of the rehearsal card would write (review MAJOR 1).
      eventP =
        (
          await owner<{ id: string }>(
            `INSERT INTO event (organizer_id, join_code, name_en, name_ar, status, starts_at, ends_at)
           VALUES ($1, 'VIEWP1', 'Preview Fest', 'مهرجان المعاينة', 'scheduled', now() + interval '2 days',
                   now() + interval '4 days') RETURNING id`,
            [ids.orgA],
          )
        )[0]?.id ?? "";
      await seedAnalytics(db.owner, eventP);
      await createStaff(db.owner, { email: "viewer@questify.test", admin: true });
      adminCookie = await signInConsole(test, "viewer@questify.test");
      // The grant is opened in the console; the dashboard is read on the public host, with its own session (Q-692).
      supportCookie = await signInFully(test, "viewer@questify.test");
      routes = test.app.routeInventory
        .filter(
          (route) => route.url.startsWith(`${ORGANIZER_PREFIX}/`) || route.url === ORGANIZER_PREFIX,
        )
        .map(({ method, url }) => ({ method, url }));
    });
    afterAll(async () => {
      await test.close();
      await db.close();
    });

    const urlOf = (pattern: string, eventId = eventP, organizerId = ids.orgA) =>
      pattern
        .replace(":organizerId", organizerId)
        .replace(":eventId", eventId)
        .replace(/:[a-zA-Z]+/g, () => randomUUID());
    const call = (method: string, url: string, payload?: object): Promise<LightMyRequestResponse> =>
      test.app.inject({
        method: method as "GET",
        url,
        headers: withSession(
          url.startsWith("/v1/admin") ? adminCookie : supportCookie,
          { "idempotency-key": randomUUID() },
          url,
        ),
        ...(payload === undefined ? {} : { payload }),
      });
    const open = async (kind: "view" | "edit", eventId = eventP) => {
      const answer = await call("POST", `/v1/admin/events/${eventId}/support`, {
        kind,
        reason: "Organizer asked for help with the dashboard",
      });
      expect(answer.statusCode, answer.body).toBe(201);
      return answer.json<{ grant: { grantId: string; kind: string } }>().grant;
    };
    const keyOf = (route: Route) => `${route.method} ${route.url.slice(ORGANIZER_PREFIX.length)}`;
    const reads = () => routes.filter((route) => route.method === "GET");
    const writes = () =>
      routes.filter((route) => route.method !== "GET" && route.method !== "HEAD");

    /**
     * Every public table's rows as one md5 each, read directly (review MINOR: not pg_stat counters). The view's own
     * bookkeeping is left out: its `support.viewed` audit rows and `support_view` throttle rows, and the sign-in's
     * session row, whose last-seen time any signed-in request moves.
     */
    const snapshot = async (): Promise<Record<string, string>> => {
      const tables = await owner<{ name: string }>(
        `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relname <> 'staff_session' ORDER BY 1`,
      );
      const skip: Record<string, string> = {
        audit_log: "WHERE action <> 'support.viewed'",
        auth_throttle: "WHERE bucket <> 'support_view'",
      };
      const sums: Record<string, string> = {};
      for (const { name } of tables) {
        const [row] = await owner<{ sum: string }>(
          `SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) AS sum
         FROM "${name}" t ${skip[name] ?? ""}`,
        );
        sums[name] = row?.sum ?? "";
      }
      return sums;
    };

    it("covers the whole organizer surface (a guard against an empty sweep)", () => {
      expect(writes().length).toBeGreaterThan(100);
      expect(reads().length).toBeGreaterThan(40);
    });

    const viewAnswers = new Map<string, Readonly<{ status: number; body: string }>>();

    it("refuses every write under a view with 403 support_view_only, and changes nothing", async () => {
      const grant = await open("view");
      expect(grant.kind).toBe("view");
      const before = await snapshot();
      const wrong: string[] = [];
      for (const route of writes()) {
        const answer = await call(route.method, urlOf(route.url), {});
        if (
          answer.statusCode !== 403 ||
          answer.json<{ code?: string }>().code !== "support_view_only"
        ) {
          wrong.push(`${keyOf(route)} -> ${answer.statusCode} ${answer.body.slice(0, 120)}`);
        }
      }
      expect(wrong).toEqual([]);
      expect(changed(before, await snapshot())).toEqual([]);
    });

    it("answers every read without a server error, writing nothing, and logs it with ids only", async () => {
      const before = await snapshot();
      const broken: string[] = [];
      for (const route of reads()) {
        const answer = await call("GET", urlOf(route.url));
        viewAnswers.set(keyOf(route), { status: answer.statusCode, body: timeless(answer.body) });
        if (
          answer.statusCode >= 500 ||
          answer.json<{ code?: string }>().code === "support_view_only"
        ) {
          broken.push(`${keyOf(route)} -> ${answer.statusCode} ${answer.body.slice(0, 160)}`);
        }
      }
      expect(broken).toEqual([]);
      expect(changed(before, await snapshot())).toEqual([]);
      for (const key of REFUSED_IN_VIEW) {
        expect(viewAnswers.get(key)?.status ?? 404, key).toBe(404);
      }
      const logged = await owner<{ after: { route: string; ids: Record<string, string> } }>(
        "SELECT after FROM audit_log WHERE action = 'support.viewed' AND event_id = $1",
        [eventP],
      );
      expect(logged.length).toBeGreaterThan(20);
      for (const { after } of logged) {
        expect(Object.keys(after).toSorted()).toEqual(["ids", "route"]);
        expect(after.route).toMatch(/^GET \/[a-zA-Z0-9/:_-]+$/);
      }
      expect(JSON.stringify(logged)).not.toMatch(/@|example\.com|questify\.test|an1_/);
    });

    it("refuses the codes and the rehearsal card in a view, and opens nothing else of the organizer", async () => {
      for (const path of ["/codes", "/rehearsal"]) {
        expect(
          (await call("GET", urlOf(`${ORGANIZER_PREFIX}/events/:eventId${path}`))).statusCode,
        ).toBe(404);
      }
      expect(
        (await call("GET", urlOf(`${ORGANIZER_PREFIX}/events/:eventId`, ids.eventA))).statusCode,
      ).toBe(404);
      expect(
        (await call("GET", urlOf(`${ORGANIZER_PREFIX}/events/:eventId`, ids.eventB, ids.orgB)))
          .statusCode,
      ).toBe(404);
      expect((await call("GET", urlOf(`${ORGANIZER_PREFIX}/members`))).statusCode).toBe(404);
      const list = await call("GET", urlOf(`${ORGANIZER_PREFIX}/events`));
      expect(list.statusCode).toBe(200);
      expect(list.body).toContain(eventP);
      expect(list.body).not.toContain(ids.eventA);
    });

    it("answers a page's parallel reads all at once (review MAJOR 2)", async () => {
      const page = [
        "",
        "/quests",
        "/rewards",
        "/players",
        "/sponsors",
        "/analytics/participation",
      ].map((path) => call("GET", urlOf(`${ORGANIZER_PREFIX}/events/:eventId${path}`)));
      const statuses = (await Promise.all(page)).map((answer) => answer.statusCode);
      expect(statuses).toEqual([200, 200, 200, 200, 200, 200]);
    });

    it("shows on every read what an edit grant on the same event shows", async () => {
      const grant = await open("edit");
      expect(grant.kind).toBe("edit");
      const differ: string[] = [];
      for (const route of reads()) {
        const key = keyOf(route);
        if (REFUSED_IN_VIEW.includes(key)) {
          continue;
        }
        // A route with an id beyond the event gets a fresh random one per call: its status is compared, not its body.
        const extraIds = /:(?!organizerId|eventId)[a-zA-Z]+/.test(route.url);
        const seen = viewAnswers.get(key);
        const answer = await call("GET", urlOf(route.url));
        if (
          seen?.status !== answer.statusCode ||
          (!extraIds && seen.body !== timeless(answer.body))
        ) {
          differ.push(
            `${key}: view ${seen?.status} ${seen?.body.slice(0, 80)} / edit ${answer.statusCode}`,
          );
        }
      }
      expect(differ).toEqual([]);
      // Why the rehearsal card is refused in a view: before go-live its first read writes (review MAJOR 1).
      const before = await snapshot();
      const card = await call("GET", urlOf(`${ORGANIZER_PREFIX}/events/:eventId/rehearsal`));
      expect(card.statusCode).toBe(200);
      expect(changed(before, await snapshot()).length).toBeGreaterThan(0);
    });

    it("refuses writes for the view's kind only: an edit grant never answers support_view_only", async () => {
      const viewOnly: string[] = [];
      for (const route of writes()) {
        const answer = await call(route.method, urlOf(route.url), {});
        if (
          answer.statusCode === 403 &&
          answer.json<{ code?: string }>().code === "support_view_only"
        ) {
          viewOnly.push(keyOf(route));
        }
      }
      expect(viewOnly).toEqual([]);
    });
  },
);
