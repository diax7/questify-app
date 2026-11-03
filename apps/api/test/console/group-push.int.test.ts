/* oxlint-disable unicorn/consistent-function-scoping -- each helper sits in the describe that uses it, beside its tests */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
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

type Method = "GET" | "POST";
type Json = Record<string, unknown>;

const TITLE = { ar: "عرض الأسبوع", en: "This week's offer" };
const BODY = { ar: "تحدٍّ جديد بانتظارك.", en: "A new challenge is waiting." };
const body = (audience: Json, over: Json = {}): Json => ({
  audience,
  title: TITLE,
  body: BODY,
  ...over,
});
const eventAudience = (joinCode: string): Json => ({ kind: "event", joinCode });
const promoAudience = (cityId: string | null = null, interests: string[] = []): Json => ({
  kind: "promo",
  cityId,
  interests,
});

/**
 * The push to a group over HTTP (T-706b, FR-1777): the console doors are for an active admin only (404 to anyone else,
 * 401 signed out); a text that breaks a rule is refused with the fields named before any door runs; the preview says who a
 * send would reach; a send needs an Idempotency-Key and a replay changes nothing; the refusals of the database come back
 * as their own answers (an event that cannot take a push, nobody to send to, too many sends); the list shows what went.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("push to a group (HTTP)", () => {
  let db: TestDatabase;
  let test: TestApp;
  let ids: Awaited<ReturnType<typeof seedTwoTenants>>;
  let adminCookie = "";
  let memberCookie = "";

  beforeAll(async () => {
    db = await createTestDatabase();
    test = await startApp(db);
    ids = await seedTwoTenants(db.owner);
    await createStaff(db.owner, { email: "admin@questify.test", admin: true });
    const memberId = await createStaff(db.owner, { email: "owner@najd.test" });
    await db.owner.query(
      "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, 'owner')",
      [ids.orgA, memberId],
    );
    adminCookie = await signInFully(test, "admin@questify.test");
    memberCookie = await signInFully(test, "owner@najd.test");
  });
  afterAll(async () => {
    await test.close();
    await db.close();
  });

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
  const admin = (method: Method, url: string, payload?: object, key?: string | null) =>
    call(method, url, adminCookie, payload, key);
  const issuesOf = (response: Json): string[] =>
    (
      ((response["details"] as Json | undefined)?.["issues"] ?? []) as {
        path: string;
        message: string;
      }[]
    )
      .map((issue) => `${issue.path}:${issue.message}`)
      .toSorted();
  const rows = async (sql: string, values: unknown[] = []) =>
    (await db.owner.query<Json>(sql, values)).rows;
  const reset = () => db.owner.query("DELETE FROM group_push");

  describe("who may use the doors", () => {
    it("answers 404 to a team member, and 401 to nobody signed in", async () => {
      const calls: [Method, string, object?][] = [
        ["GET", "/v1/admin/group-pushes"],
        ["POST", "/v1/admin/group-pushes/preview", body(eventAudience("NAJD1"))],
        ["POST", "/v1/admin/group-pushes", body(eventAudience("NAJD1"))],
      ];
      for (const [method, url, payload] of calls) {
        expect((await call(method, url, memberCookie, payload)).statusCode, url).toBe(404);
        expect((await call(method, url, "", payload)).statusCode, url).toBe(401);
      }
      expect(await rows("SELECT 1 FROM group_push")).toEqual([]);
    });
  });

  describe("a text or an audience that breaks a rule", () => {
    it("is refused with the fields named, and nothing is stored", async () => {
      const refused: [string, Json, string[]][] = [
        [
          "an empty title",
          body(eventAudience("NAJD1"), { title: { ar: "", en: TITLE.en } }),
          ["title.ar:required"],
        ],
        [
          "the wrong script",
          body(eventAudience("NAJD1"), { body: { ar: "English", en: BODY.en } }),
          ["body.ar:language"],
        ],
        [
          "a placeholder",
          body(eventAudience("NAJD1"), { body: { ar: BODY.ar, en: "Hi {name}" } }),
          ["body.en:placeholderUnknown"],
        ],
        [
          "an address",
          body(eventAudience("NAJD1"), {
            body: { ar: BODY.ar, en: "Win at https://example.com now" },
          }),
          ["body.en:looks_like_address"],
        ],
        [
          "a text over 140 characters",
          body(eventAudience("NAJD1"), { body: { ar: BODY.ar, en: "x".repeat(141) } }),
          ["body.en:tooLong"],
        ],
        ["an unknown audience", body({ kind: "everyone" }), ["audience:Invalid input"]],
        [
          "a repeated interest",
          body(promoAudience(null, ["music", "music"])),
          ["audience.interests:no repeats"],
        ],
      ];
      for (const [name, payload, issues] of refused) {
        for (const url of ["/v1/admin/group-pushes/preview", "/v1/admin/group-pushes"]) {
          const response = await admin("POST", url, payload);
          expect(response.statusCode, `${name} ${url}`).toBe(422);
          expect(response.json<Json>()["code"], name).toBe("invalid_catalog");
          if (issues[0]?.endsWith("Invalid input") !== true) {
            expect(issuesOf(response.json<Json>()), name).toEqual(issues);
          }
        }
      }
      expect(
        (await admin("POST", "/v1/admin/group-pushes", { ...body(promoAudience()), extra: 1 }))
          .statusCode,
      ).toBe(422);
      expect(await rows("SELECT 1 FROM group_push")).toEqual([]);
    });

    it("answers for an event that is not there, and for one that cannot take a push", async () => {
      const unknown = await admin(
        "POST",
        "/v1/admin/group-pushes/preview",
        body(eventAudience("NOPE99")),
      );
      expect(unknown.statusCode).toBe(404);
      await db.owner.query(
        `INSERT INTO event (organizer_id, join_code, name_en, status) VALUES ($1, 'DRAFT1', 'Not yet', 'draft')`,
        [ids.orgA],
      );
      const closed = await admin("POST", "/v1/admin/group-pushes", body(eventAudience("DRAFT1")));
      expect(closed.statusCode).toBe(409);
      expect(closed.json<Json>()["code"]).toBe("group_push_event_closed");
    });

    it("answers 409 when nobody would receive it", async () => {
      await db.owner.query(
        "INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at) VALUES ($1, 'EMPTY1', 'Empty', 'live', now() - interval '1 hour', now() + interval '1 day')",
        [ids.orgA],
      );
      for (const audience of [eventAudience("EMPTY1"), promoAudience("sa-hail", ["wellness"])]) {
        const response = await admin("POST", "/v1/admin/group-pushes", body(audience));
        expect(response.statusCode).toBe(409);
        expect(response.json<Json>()["code"]).toBe("group_push_nobody");
      }
    });
  });

  describe("a push to an event", () => {
    it("previews the event and its reach, whatever the case of the join code, for any organizer", async () => {
      for (const [code, name, reach] of [
        ["NAJD1", "Tech Fest", 1],
        ["najd1", "Tech Fest", 1],
        ["TABUK1", "Winter Fest", 1],
      ] as const) {
        const response = await admin(
          "POST",
          "/v1/admin/group-pushes/preview",
          body(eventAudience(code)),
        );
        expect(response.statusCode, code).toBe(200);
        expect(response.json<{ preview: Json }>().preview).toMatchObject({
          audience: "event",
          reach,
          capped: false,
          event: { joinCode: code.toUpperCase(), status: "live", name: { en: name } },
        });
      }
    });

    it("sends it once, writes its notice, lists it, and a replay of the same key changes nothing", async () => {
      await reset();
      const key = randomUUID();
      const payload = body(eventAudience("NAJD1"), {
        title: { ar: "  عرض   الأسبوع ", en: "This   week's offer" },
        body: { ar: "تحدٍّ جديد ٣ نقاط", en: "A new\nchallenge" },
      });
      const first = await admin("POST", "/v1/admin/group-pushes", payload, key);
      expect(first.statusCode).toBe(201);
      const sent = first.json<{ push: Json }>().push;
      expect(sent).toMatchObject({
        audience: "event",
        state: "done",
        reach: 1,
        notices: 1,
        title: { ar: "عرض الأسبوع", en: "This week's offer" },
        body: { ar: "تحدٍّ جديد 3 نقاط", en: "A new challenge" },
      });
      const replay = await admin("POST", "/v1/admin/group-pushes", payload, key);
      expect(replay.statusCode).toBe(201);
      expect(replay.json<{ push: Json }>().push["id"]).toBe(sent["id"]);
      expect(await rows("SELECT id FROM group_push")).toHaveLength(1);
      expect(
        await rows("SELECT kind, event_id FROM notice WHERE dedupe = $1", [`gpush:${sent["id"]}`]),
      ).toEqual([{ kind: "group_push_event", event_id: ids.eventA }]);

      const listed = await admin("GET", "/v1/admin/group-pushes");
      expect(listed.statusCode).toBe(200);
      expect(listed.json<{ pushes: Json[] }>().pushes.map((one) => one["id"])).toEqual([
        sent["id"],
      ]);
    });

    it("refuses a send without an Idempotency-Key", async () => {
      await reset();
      const response = await admin(
        "POST",
        "/v1/admin/group-pushes",
        body(eventAudience("NAJD1")),
        null,
      );
      expect(response.statusCode).toBe(400);
      expect(await rows("SELECT 1 FROM group_push")).toEqual([]);
    });
  });

  describe("a push to opted-in players", () => {
    it("previews the players it would reach and sends to a city, leaving the writing to the push worker", async () => {
      await reset();
      const made = await db.owner.query<{ id: string }>(
        `INSERT INTO player (username, birth_year)
         SELECT 'http_' || g, extract(year FROM now() AT TIME ZONE 'Asia/Riyadh')::integer - 30
         FROM generate_series(1, 3) g RETURNING id`,
      );
      const players = made.rows.map((row) => row.id);
      await db.owner.query(
        `INSERT INTO marketing_consent (player_id, channel, granted, method, text_version)
         SELECT id, 'push', true, 'settings', '1' FROM unnest($1::uuid[]) id`,
        [players],
      );
      await db.owner.query(
        `INSERT INTO player_preference (player_id, city_id, interests)
         SELECT id, 'sa-jubail', '{food}' FROM unnest($1::uuid[]) id`,
        [players],
      );
      const audience = promoAudience("sa-jubail", ["food"]);
      const seen = await admin("POST", "/v1/admin/group-pushes/preview", body(audience));
      expect(seen.json<{ preview: Json }>().preview).toMatchObject({
        audience: "promo",
        reach: 3,
        event: null,
        cityId: "sa-jubail",
        interests: ["food"],
      });
      const sent = await admin("POST", "/v1/admin/group-pushes", body(audience));
      expect(sent.statusCode).toBe(201);
      expect(sent.json<{ push: Json }>().push).toMatchObject({
        audience: "promo",
        state: "sending",
        reach: 3,
        notices: 0,
        cityId: "sa-jubail",
      });
      expect(await rows("SELECT 1 FROM notice WHERE kind = 'group_push_promo'")).toEqual([]);
    });

    it("answers 429 after ten sends an hour from one admin, whatever the answer to each", async () => {
      await reset();
      await createStaff(db.owner, { email: "second-admin@questify.test", admin: true });
      const cookie = await signInFully(test, "second-admin@questify.test");
      const send = () =>
        call("POST", "/v1/admin/group-pushes", cookie, body(promoAudience("sa-al-baha")));
      for (let n = 1; n <= 10; n += 1) {
        expect((await send()).statusCode, `send ${n}`).toBe(409);
      }
      const eleventh = await send();
      expect(eleventh.statusCode).toBe(429);
      expect(eleventh.headers["retry-after"]).toBeDefined();
      expect(
        (await admin("POST", "/v1/admin/group-pushes", body(promoAudience("sa-al-baha"))))
          .statusCode,
      ).toBe(409);
    });
  });
});
