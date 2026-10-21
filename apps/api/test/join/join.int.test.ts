import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshIp, startApp, type TestApp } from "#test/support/auth-app";
import {
  TEST_DATABASE_URL,
  createTestDatabase,
  seedTwoTenants,
  type TestDatabase,
} from "#test/support/test-db";

type Row = Record<string, unknown>;

/**
 * Joining over HTTP (T-111): the public list, the join card by code, an event's quests before sign-in, the join itself
 * and the switcher's list; wrong codes are throttled per address and per player, right ones cost nothing.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("joining an event", () => {
  let db: TestDatabase;
  let test: TestApp;
  let ids: Awaited<ReturnType<typeof seedTwoTenants>>;
  let counter = 0;

  beforeAll(async () => {
    db = await createTestDatabase();
    test = await startApp(db);
    ids = await seedTwoTenants(db.owner);
  });
  afterAll(async () => {
    await test.close();
    await db.close();
  });

  const owner = async <T extends Row>(sql: string, values: unknown[] = []) =>
    (await db.owner.query<T>(sql, values)).rows;

  type EventSpec = {
    organizer?: string;
    access?: "public" | "unlisted" | "private";
    status?: string;
    methods?: string[];
    startsIn?: string;
    endsIn?: string;
  };

  const newEvent = async (spec: EventSpec = {}): Promise<{ id: string; code: string }> => {
    counter += 1;
    const code = `HJ${String(counter).padStart(4, "0")}`;
    const [event] = await owner<{ id: string }>(
      `INSERT INTO event (organizer_id, join_code, name_ar, name_en, venue_en, status, access, join_methods, starts_at,
                          ends_at)
       VALUES ($1, $2, 'مهرجان', 'Join Fest', 'Hall 3', $3, $4, $5, now() + $6::interval, now() + $7::interval)
       RETURNING id`,
      [
        spec.organizer ?? ids.orgA,
        code,
        spec.status ?? "live",
        spec.access ?? "public",
        spec.methods ?? ["code", "qr", "link"],
        spec.startsIn ?? "-1 hour",
        spec.endsIn ?? "1 day",
      ],
    );
    return { id: event?.id ?? "", code };
  };

  /** A player with a bearer session. */
  const newPlayer = async (): Promise<{ id: string; token: string }> => {
    counter += 1;
    const [made] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`join_http_${counter}`],
    );
    const id = made?.id ?? "";
    const token = randomBytes(32).toString("base64url");
    await owner(
      "INSERT INTO player_session (player_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
      [id, createHash("sha256").update(token).digest()],
    );
    return { id, token };
  };

  const get = (url: string, ip = freshIp()) =>
    test.app.inject({ method: "GET", url, headers: { "x-forwarded-for": ip } });
  const join = (token: string, payload: object, ip = freshIp()) =>
    test.app.inject({
      method: "POST",
      url: "/v1/join",
      headers: { authorization: `Bearer ${token}`, "x-forwarded-for": ip },
      payload: { via: "code", cardVersion: "0.1", ...payload },
    });

  describe("the public list", () => {
    it("shows only public events that list themselves, page by page", async () => {
      const listed = [
        await newEvent({ methods: ["code", "public_list"] }),
        await newEvent({
          methods: ["public_list"],
          status: "scheduled",
          startsIn: "1 day",
          endsIn: "2 days",
        }),
        await newEvent({
          methods: ["public_list"],
          status: "scheduled",
          startsIn: "2 days",
          endsIn: "3 days",
        }),
      ];
      const hidden = [
        await newEvent(),
        await newEvent({ access: "unlisted" }),
        await newEvent({ access: "private" }),
      ];
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const page = await get(
          `/v1/public/events?limit=2${cursor === null ? "" : `&cursor=${cursor}`}`,
        );
        expect(page.statusCode).toBe(200);
        const body = page.json<{ events: { id: string }[]; nextCursor: string | null }>();
        expect(body.events.length).toBeLessThanOrEqual(2);
        seen.push(...body.events.map((event) => event.id));
        pages += 1;
        expect(body.nextCursor === null, `page ${pages}`).toBe(body.events.length < 2);
        cursor = body.nextCursor;
      } while (cursor !== null);
      expect(pages).toBe(2);
      expect(seen).toEqual(listed.map((event) => event.id));
      for (const event of hidden) {
        expect(seen).not.toContain(event.id);
      }
      const [first] = (await get("/v1/public/events")).json<{ events: Row[] }>().events;
      expect(first).toEqual({
        id: listed[0]?.id,
        joinCode: listed[0]?.code,
        name: { ar: "مهرجان", en: "Join Fest" },
        venue: { ar: null, en: "Hall 3" },
        kind: "physical",
        timezone: "Asia/Riyadh",
        startsAt: expect.any(String),
        endsAt: expect.any(String),
        statusNow: "live",
      });
    });

    it("refuses a malformed cursor or limit, and starts again from an unknown event", async () => {
      for (const query of [
        "cursor=***",
        "cursor=e30",
        "limit=0",
        "limit=101",
        "limit=two",
        "extra=1",
      ]) {
        expect((await get(`/v1/public/events?${query}`)).statusCode, query).toBe(400);
      }
      const stale = Buffer.from(
        JSON.stringify({ id: "00000000-0000-4000-8000-000000000000" }),
      ).toString("base64url");
      expect((await get(`/v1/public/events?cursor=${stale}`)).json()).toEqual(
        (await get("/v1/public/events")).json(),
      );
    });
  });

  describe("the join card", () => {
    it("opens any access type by its code, in any case, with the card in both languages", async () => {
      const event = await newEvent({ access: "private", methods: ["link"] });
      const card = await get(`/v1/public/events/${event.code.toLowerCase()}`);
      expect(card.statusCode).toBe(200);
      expect(card.json()).toMatchObject({
        event: {
          id: event.id,
          joinCode: event.code,
          access: "private",
          joinMethods: ["link"],
          statusNow: "live",
        },
        card: {
          version: "0.1",
          title: { ar: "سيرى منظّم الفعالية", en: "The event's organizer will see" },
          receives: [
            { en: "Your username and avatar" },
            { en: "Your points and the quests you complete in this event" },
            { en: "The prizes you collect" },
          ],
        },
      });
      expect(Object.keys(card.json<{ event: Row }>().event)).not.toContain("organizerId");
    });

    it("shows an ended event as ended, and nothing for a draft, archived, unknown or malformed code", async () => {
      const ended = await newEvent({ startsIn: "-2 days", endsIn: "-1 day" });
      expect((await get(`/v1/public/events/${ended.code}`)).json()).toMatchObject({
        event: { statusNow: "ended" },
      });
      const draft = await newEvent({ status: "draft" });
      const archived = await newEvent({ status: "archived" });
      for (const code of [draft.code, archived.code, "NOPE99", "x", "has-dash"]) {
        expect((await get(`/v1/public/events/${code}`)).statusCode, code).toBe(404);
      }
    });
  });

  describe("quests before sign-in", () => {
    it("lists a public event's visible quests without their answers, and keeps a private event's for members", async () => {
      const event = await newEvent({ access: "unlisted" });
      const [general] = await owner<{ id: string }>("SELECT id FROM category WHERE event_id = $1", [
        event.id,
      ]);
      await owner(
        `INSERT INTO quest (event_id, category_id, type, title_en, description_en, points, type_config)
         VALUES ($1, $2, 'enter_code', 'Say the word', 'Ask at booth 7', 50, '{"code": "FALCON42"}')`,
        [event.id, general?.id],
      );
      const quests = await get(`/v1/public/events/${event.code}/quests`);
      expect(quests.json()).toMatchObject({
        categories: [
          {
            id: general?.id,
            name: { en: "General" },
            quests: [
              {
                title: { en: "Say the word" },
                description: { en: "Ask at booth 7" },
                type: "enter_code",
                points: 50,
              },
            ],
          },
        ],
      });
      expect(quests.body).not.toContain("FALCON42");
      const hidden = await newEvent({ access: "private" });
      const refused = await get(`/v1/public/events/${hidden.code}/quests`);
      expect([refused.statusCode, refused.json<{ code: string }>().code]).toEqual([
        403,
        "members_only",
      ]);
      expect((await get("/v1/public/events/NOPE99/quests")).statusCode).toBe(404);
    });
  });

  describe("wrong codes", () => {
    it("counts only misses per address, then refuses every lookup from it, right codes too", async () => {
      const event = await newEvent();
      const door = freshIp();
      for (let i = 0; i < 30; i += 1) {
        expect((await get(`/v1/public/events/${event.code}`, door)).statusCode).toBe(200);
      }
      for (let i = 0; i < 60; i += 1) {
        expect(
          (await get(`/v1/public/events/MISS${String(i).padStart(2, "0")}`, door)).statusCode,
        ).toBe(404);
      }
      const blocked = await get(`/v1/public/events/${event.code}/quests`, door);
      expect(blocked.statusCode).toBe(429);
      const retryAfter = Number(blocked.headers["retry-after"]);
      expect(retryAfter).toBeGreaterThan(0);
      expect(blocked.json()).toMatchObject({
        code: "too_many_attempts",
        details: { retryAfterSeconds: retryAfter },
      });
      expect((await get(`/v1/public/events/${event.code}`, door)).statusCode).toBe(429);
      expect((await get(`/v1/public/events/${event.code}`, freshIp())).statusCode).toBe(200);
    });

    it("never counts a malformed code, which can name no event", async () => {
      const event = await newEvent();
      const door = freshIp();
      const player = await newPlayer();
      for (let i = 0; i < 70; i += 1) {
        const code = ["x-ABCD", "ABCD-x", "AB", "ABCD.EF"][i % 4] ?? "";
        expect((await get(`/v1/public/events/${code}`, door)).statusCode).toBe(404);
      }
      for (let i = 0; i < 25; i += 1) {
        expect((await join(player.token, { joinCode: "x-ABCD" }, door)).statusCode).toBe(404);
      }
      expect((await get(`/v1/public/events/${event.code}`, door)).statusCode).toBe(200);
      expect((await join(player.token, { joinCode: event.code }, door)).statusCode).toBe(200);
    });

    it("lets no more misses through than the budget when they arrive all at once", async () => {
      const event = await newEvent();
      const door = freshIp();
      const answers = await Promise.all(
        Array.from({ length: 80 }, (_, i) =>
          get(`/v1/public/events/BURST${String(i).padStart(2, "0")}`, door),
        ),
      );
      const statuses = answers.map((answer) => answer.statusCode);
      const missed = statuses.filter((status) => status === 404).length;
      // Reservations still in flight count too, so a burst may stop short of the budget: never past it.
      expect(missed).toBeLessThanOrEqual(60);
      expect(statuses.filter((status) => status !== 404 && status !== 429)).toEqual([]);
      for (let i = missed; i < 60; i += 1) {
        expect(
          (await get(`/v1/public/events/LATE${String(i).padStart(2, "0")}`, door)).statusCode,
        ).toBe(404);
      }
      expect((await get(`/v1/public/events/${event.code}`, door)).statusCode).toBe(429);
    });

    it("holds a player's misses against them on joins from any address", async () => {
      const player = await newPlayer();
      for (let i = 0; i < 20; i += 1) {
        expect(
          (await join(player.token, { joinCode: `PMIS${String(i).padStart(2, "0")}` })).statusCode,
        ).toBe(404);
      }
      const event = await newEvent();
      expect((await join(player.token, { joinCode: event.code })).statusCode).toBe(429);
    });
  });

  describe("joining", () => {
    it("joins, answers the same enrollment again, and lists it for the switcher", async () => {
      const player = await newPlayer();
      const open = await newEvent();
      const closed = await newEvent({ organizer: ids.orgB, access: "private" });
      const first = await join(player.token, { joinCode: open.code.toLowerCase(), via: "qr" });
      expect(first.statusCode).toBe(200);
      expect(first.json()).toEqual({
        enrollmentId: expect.any(String),
        eventId: open.id,
        status: "active",
        alreadyMember: false,
      });
      expect((await join(player.token, { joinCode: open.code })).json()).toEqual({
        ...first.json<Row>(),
        alreadyMember: true,
      });
      expect((await join(player.token, { joinCode: closed.code })).json()).toMatchObject({
        eventId: closed.id,
        status: "pending",
      });
      const mine = await test.app.inject({
        method: "GET",
        url: "/v1/me/events",
        headers: { authorization: `Bearer ${player.token}` },
      });
      expect(
        mine.json<{ events: Row[] }>().events.map((event) => [event["id"], event["status"]]),
      ).toEqual([
        [closed.id, "pending"],
        [open.id, "active"],
      ]);
      expect(mine.json<{ events: Row[] }>().events[1]).toMatchObject({
        score: 0,
        balance: 0,
        statusNow: "live",
      });
    });

    it("answers each refusal with its own code and joins nothing", async () => {
      const player = await newPlayer();
      const ended = await newEvent({ startsIn: "-2 days", endsIn: "-1 day" });
      const qrOnly = await newEvent({ methods: ["qr"] });
      const banned = await newEvent();
      await join(player.token, { joinCode: banned.code });
      await owner("UPDATE enrollment SET status = 'banned' WHERE player_id = $1", [player.id]);
      for (const [payload, status, code] of [
        [{ joinCode: ended.code }, 409, "event_ended"],
        [{ joinCode: qrOnly.code }, 403, "join_method_off"],
        [{ joinCode: banned.code }, 403, "join_not_allowed"],
        [{ joinCode: "NOPE99" }, 404, "not_found"],
        [{ joinCode: "has-dash" }, 404, "not_found"],
      ] as const) {
        const refused = await join(player.token, payload);
        expect(
          [refused.statusCode, refused.json<{ code: string }>().code],
          payload.joinCode,
        ).toEqual([status, code]);
        expect(Object.keys(refused.json<{ details?: Row }>().details ?? {})).toEqual([]);
      }
      expect(
        await owner("SELECT status FROM enrollment WHERE player_id = $1", [player.id]),
      ).toEqual([{ status: "banned" }]);
    });

    it("joins by a link or from the public list, which only a listed event takes", async () => {
      const listed = await newEvent({ methods: ["link", "public_list"] });
      const unlisted = await newEvent({ methods: ["code"] });
      const player = await newPlayer();
      expect(
        (await join(player.token, { joinCode: listed.code, via: "public_list" })).statusCode,
      ).toBe(200);
      expect(
        (await join((await newPlayer()).token, { joinCode: listed.code, via: "link" })).statusCode,
      ).toBe(200);
      const refused = await join(player.token, { joinCode: unlisted.code, via: "public_list" });
      expect(refused.json<{ code: string }>().code).toBe("join_method_off");
    });

    it("tells a malformed card version from a stale one", async () => {
      const player = await newPlayer();
      const event = await newEvent();
      for (const version of ["v0.1", "0.1x", "1.2.3.4", "new"]) {
        expect(
          (await join(player.token, { joinCode: event.code, cardVersion: version })).statusCode,
          version,
        ).toBe(400);
      }
      for (const version of ["1", "10.1", "0.10", "1.2.3"]) {
        expect(
          (await join(player.token, { joinCode: event.code, cardVersion: version })).statusCode,
          version,
        ).toBe(422);
      }
    });

    it("asks for the card in force, refuses a malformed body and needs a session", async () => {
      const player = await newPlayer();
      const event = await newEvent();
      const stale = await join(player.token, { joinCode: event.code, cardVersion: "0.0" });
      expect(stale.statusCode).toBe(422);
      expect(stale.json()).toMatchObject({
        code: "card_version_stale",
        details: { card: { version: "0.1" } },
      });
      for (const payload of [
        { via: "sms" },
        { cardVersion: "v1" },
        { extra: true },
        { joinCode: "TOOLONGCODE99" },
      ]) {
        expect((await join(player.token, { joinCode: event.code, ...payload })).statusCode).toBe(
          400,
        );
      }
      const anonymous = await test.app.inject({
        method: "POST",
        url: "/v1/join",
        payload: { joinCode: event.code, via: "code", cardVersion: "0.1" },
      });
      expect(anonymous.statusCode).toBe(401);
      expect(await owner("SELECT 1 FROM enrollment WHERE player_id = $1", [player.id])).toEqual([]);
    });
  });
});
