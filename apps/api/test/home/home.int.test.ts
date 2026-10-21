import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withRequestContext } from "#src/db/context";
import {
  createStaff,
  signInFully,
  startApp,
  withSession,
  type TestApp,
} from "#test/support/auth-app";
import { TEST_DATABASE_URL, createTestDatabase, type TestDatabase } from "#test/support/test-db";

type Row = Record<string, unknown>;

/**
 * Inside an event over HTTP (T-113): its Home and quests for members, and the quest an organizer pins as Up next.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("the event home over HTTP", () => {
  let db: TestDatabase;
  let test: TestApp;
  let organizer: string;
  let otherOrganizer: string;
  let cookie: string;
  let counter = 0;

  beforeAll(async () => {
    db = await createTestDatabase();
    test = await startApp(db);
    const made = async (name: string) =>
      (
        await db.owner.query<{ id: string }>(
          "INSERT INTO organizer (name, slug) VALUES ($1, $1) RETURNING id",
          [name],
        )
      ).rows[0]?.id ?? "";
    organizer = await made("home-org");
    otherOrganizer = await made("home-other");
    const editor = await createStaff(db.owner, { email: "editor@home.test" });
    await db.owner.query(
      "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, 'editor')",
      [organizer, editor],
    );
    cookie = await signInFully(test, "editor@home.test");
  });
  afterAll(async () => {
    await test.close();
    await db.close();
  });

  const owner = async <T extends Row>(sql: string, values: unknown[] = []) =>
    (await db.owner.query<T>(sql, values)).rows;

  const focusOf = async (event: string) =>
    (
      await owner<{ focus_quest_id: string | null }>(
        "SELECT focus_quest_id FROM event WHERE id = $1",
        [event],
      )
    )[0]?.focus_quest_id;

  type EventSpec = { org?: string; status?: string; startsIn?: string; endsIn?: string };

  const newEvent = async (spec: EventSpec = {}): Promise<{ id: string; category: string }> => {
    counter += 1;
    const [event] = await owner<{ id: string }>(
      `INSERT INTO event (organizer_id, join_code, name_ar, name_en, venue_en, status, starts_at, ends_at)
       VALUES ($1, $2, 'مهرجان', 'Home Fest', 'Hall 3', $3, now() + $4::interval, now() + $5::interval) RETURNING id`,
      [
        spec.org ?? organizer,
        `HOME${counter}`,
        spec.status ?? "live",
        spec.startsIn ?? "-1 hour",
        spec.endsIn ?? "1 day",
      ],
    );
    const [category] = await owner<{ id: string }>("SELECT id FROM category WHERE event_id = $1", [
      event?.id,
    ]);
    return { id: event?.id ?? "", category: category?.id ?? "" };
  };

  const newQuest = async (
    event: { id: string; category: string },
    fields: { points?: number; cap?: number; visible?: boolean; title?: string } = {},
  ): Promise<string> => {
    const [quest] = await owner<{ id: string }>(
      `INSERT INTO quest (event_id, category_id, type, title_en, points, repeat_cap, visible, type_config)
       VALUES ($1, $2, 'enter_code', $3, $4, $5, $6, '{"code": "SECRET"}') RETURNING id`,
      [
        event.id,
        event.category,
        fields.title ?? "A quest",
        fields.points ?? 10,
        fields.cap ?? 1,
        fields.visible ?? true,
      ],
    );
    return quest?.id ?? "";
  };

  /** A player with a bearer session, enrolled in the event with a status, or not at all. */
  const newPlayer = async (
    event: string | null,
    status = "active",
  ): Promise<{ id: string; token: string }> => {
    counter += 1;
    const [player] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`home_http_${counter}`],
    );
    const id = player?.id ?? "";
    const token = randomBytes(32).toString("base64url");
    await owner(
      "INSERT INTO player_session (player_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
      [id, createHash("sha256").update(token).digest()],
    );
    if (event !== null) {
      await owner(
        "INSERT INTO enrollment (organizer_id, event_id, player_id, status) SELECT organizer_id, id, $2, $3 FROM event WHERE id = $1",
        [event, id, status],
      );
    }
    return { id, token };
  };

  const complete = (player: string, quest: string) =>
    withRequestContext(db.app, { playerId: player }, () =>
      db.app.query("SELECT * FROM complete_quest($1, 'code', NULL, 'SECRET', $2, NULL)", [
        quest,
        randomUUID(),
      ]),
    );

  const asPlayer = (token: string, url: string) =>
    test.app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });

  const pin = (event: string, questId: string | null, org = organizer, payload?: object) =>
    test.app.inject({
      method: "PUT",
      url: `/v1/organizers/${org}/events/${event}/focus`,
      headers: withSession(cookie),
      payload: payload ?? { questId },
    });

  describe("GET /v1/events/:eventId/home", () => {
    it("gives an active member the event, their standing and progress, and Up next", async () => {
      const event = await newEvent();
      const small = await newQuest(event, { points: 5 });
      const big = await newQuest(event, { points: 40, title: "Big one" });
      const twice = await newQuest(event, { points: 20, cap: 2 });
      await newQuest(event, { points: 99, visible: false });
      const player = await newPlayer(event.id);
      await complete(player.id, small);
      await complete(player.id, twice);
      const home = await asPlayer(player.token, `/v1/events/${event.id}/home`);
      expect(home.statusCode).toBe(200);
      expect(home.json()).toMatchObject({
        event: {
          id: event.id,
          name: { ar: "مهرجان", en: "Home Fest" },
          venue: { ar: null, en: "Hall 3" },
          timezone: "Asia/Riyadh",
          statusNow: "live",
        },
        // `twice` is done once of two, so only `small` is finished; the hidden quest counts for nothing.
        standing: { status: "active", score: 25, balance: 25, questsDone: 1, questsTotal: 3 },
        upNext: {
          questId: big,
          title: { ar: null, en: "Big one" },
          points: 40,
          type: "enter_code",
        },
        rankingOn: true,
      });
      expect(home.body).not.toContain("SECRET");
      expect(twice).not.toBe(big);
    });

    it("follows the organizer's pin while the quest is open for the player", async () => {
      const event = await newEvent();
      await newQuest(event, { points: 40 });
      const pinned = await newQuest(event, { points: 1 });
      const player = await newPlayer(event.id);
      expect((await pin(event.id, pinned)).statusCode).toBe(200);
      const upNext = async () =>
        (await asPlayer(player.token, `/v1/events/${event.id}/home`)).json<{
          upNext: { questId: string } | null;
        }>().upNext?.questId;
      expect(await upNext()).toBe(pinned);
      await complete(player.id, pinned);
      expect(await upNext()).not.toBe(pinned);
    });

    it("has no Up next before the event starts", async () => {
      const event = await newEvent({ status: "scheduled", startsIn: "1 day", endsIn: "2 days" });
      await newQuest(event);
      const player = await newPlayer(event.id);
      const home = await asPlayer(player.token, `/v1/events/${event.id}/home`);
      expect(home.json()).toMatchObject({ event: { statusNow: "scheduled" }, upNext: null });
    });

    it("says when the ranking is off", async () => {
      const event = await newEvent();
      await owner(`UPDATE event SET config = '{"features": {"ranking": false}}' WHERE id = $1`, [
        event.id,
      ]);
      const player = await newPlayer(event.id);
      const home = await asPlayer(player.token, `/v1/events/${event.id}/home`);
      expect(home.json()).toMatchObject({ rankingOn: false });
    });

    it("reads the ranking switch of an unlisted or private event the player joined", async () => {
      for (const access of ["unlisted", "private"]) {
        const event = await newEvent();
        await owner("UPDATE event SET access = $2 WHERE id = $1", [event.id, access]);
        const player = await newPlayer(event.id);
        const home = await asPlayer(player.token, `/v1/events/${event.id}/home`);
        expect(home.json(), access).toMatchObject({ rankingOn: true });
      }
    });

    it("gives a pending member the event and 'pending' only", async () => {
      const event = await newEvent();
      await newQuest(event);
      const player = await newPlayer(event.id, "pending");
      const home = await asPlayer(player.token, `/v1/events/${event.id}/home`);
      expect(home.statusCode).toBe(200);
      const body = home.json<Row>();
      expect(body["standing"]).toEqual({ status: "pending" });
      expect(body["upNext"]).toBeNull();
    });

    it.each(["left", "removed", "banned"])("refuses a %s member", async (status) => {
      const event = await newEvent();
      const player = await newPlayer(event.id, status);
      const home = await asPlayer(player.token, `/v1/events/${event.id}/home`);
      expect(home.statusCode).toBe(403);
      expect(home.json()).toMatchObject({ code: "not_enrolled" });
    });

    it("answers a stranger the same for an event that exists and one that does not", async () => {
      const event = await newEvent();
      const stranger = await newPlayer(null);
      const real = await asPlayer(stranger.token, `/v1/events/${event.id}/home`);
      const missing = await asPlayer(stranger.token, `/v1/events/${randomUUID()}/home`);
      expect(real.statusCode).toBe(403);
      expect(missing.statusCode).toBe(403);
      expect(real.json()).toEqual(missing.json());
    });

    it("needs a signed-in player and an event id", async () => {
      const event = await newEvent();
      expect(
        (await test.app.inject({ method: "GET", url: `/v1/events/${event.id}/home` })).statusCode,
      ).toBe(401);
      const player = await newPlayer(event.id);
      expect((await asPlayer(player.token, "/v1/events/not-a-uuid/home")).statusCode).toBe(400);
    });
  });

  describe("GET /v1/events/:eventId/quests", () => {
    it("gives an active member the categories and visible quests with their own progress", async () => {
      const event = await newEvent();
      const shown = await newQuest(event, { cap: 2 });
      await newQuest(event, { visible: false });
      const player = await newPlayer(event.id);
      await complete(player.id, shown);
      const answer = await asPlayer(player.token, `/v1/events/${event.id}/quests`);
      expect(answer.statusCode).toBe(200);
      const { categories } = answer.json<{ categories: { id: string; quests: Row[] }[] }>();
      expect(categories.map((category) => category.id)).toEqual([event.category]);
      expect(categories[0]).toMatchObject({ name: { ar: "عام", en: "General" } });
      expect(categories[0]?.quests).toEqual([
        {
          id: shown,
          title: { ar: null, en: "A quest" },
          description: { ar: null, en: null },
          type: "enter_code",
          points: 10,
          repeatCap: 2,
          opensAt: null,
          closesAt: null,
          done: 1,
          earned: 10,
          state: "open",
        },
      ]);
      expect(answer.body).not.toContain("SECRET");
    });

    it("refuses a stranger", async () => {
      const event = await newEvent();
      const stranger = await newPlayer(null);
      const answer = await asPlayer(stranger.token, `/v1/events/${event.id}/quests`);
      expect(answer.statusCode).toBe(403);
      expect(answer.json()).toMatchObject({ code: "not_enrolled" });
    });

    it("tells a pending member they wait for approval, and nothing else", async () => {
      const event = await newEvent();
      await newQuest(event);
      const player = await newPlayer(event.id, "pending");
      const answer = await asPlayer(player.token, `/v1/events/${event.id}/quests`);
      expect(answer.statusCode).toBe(403);
      expect(answer.json()).toMatchObject({ code: "membership_pending" });
      expect(answer.body).not.toContain("A quest");
    });

    it.each(["left", "removed", "banned"])("refuses a %s member", async (status) => {
      const event = await newEvent();
      const player = await newPlayer(event.id, status);
      const answer = await asPlayer(player.token, `/v1/events/${event.id}/quests`);
      expect(answer.statusCode).toBe(403);
      expect(answer.json()).toMatchObject({ code: "not_enrolled" });
    });

    it("gives each quest its state on the server's clock, and the event's status and zone", async () => {
      const event = await newEvent();
      const open = await newQuest(event);
      const finishedQuest = await newQuest(event);
      const later = await newQuest(event);
      const over = await newQuest(event);
      await owner("UPDATE quest SET opens_at = now() + interval '1 hour' WHERE id = $1", [later]);
      await owner("UPDATE quest SET closes_at = now() - interval '1 minute' WHERE id = $1", [over]);
      const player = await newPlayer(event.id);
      await complete(player.id, finishedQuest);
      const answer = await asPlayer(player.token, `/v1/events/${event.id}/quests`);
      const body = answer.json<{ event: Row; categories: { quests: Row[] }[] }>();
      expect(body.event).toEqual({ statusNow: "live", timezone: "Asia/Riyadh" });
      const stateOf = (id: string) =>
        body.categories[0]?.quests.find((q) => q["id"] === id)?.["state"];
      expect([open, finishedQuest, later, over].map(stateOf)).toEqual([
        "open",
        "done",
        "not_yet",
        "closed",
      ]);
    });

    it("says not live for every unfinished quest before the event starts", async () => {
      const event = await newEvent({ status: "scheduled", startsIn: "1 day", endsIn: "2 days" });
      await newQuest(event);
      const player = await newPlayer(event.id);
      const body = (await asPlayer(player.token, `/v1/events/${event.id}/quests`)).json<{
        event: Row;
        categories: { quests: Row[] }[];
      }>();
      expect(body.event["statusNow"]).toBe("scheduled");
      expect(body.categories[0]?.quests[0]?.["state"]).toBe("not_live");
    });
  });

  describe("GET /v1/events/:eventId/activity", () => {
    it("lists the player's own points record, newest first, page by page", async () => {
      const event = await newEvent();
      const quest = await newQuest(event, { cap: 5, title: "Find the word" });
      const player = await newPlayer(event.id);
      for (let n = 0; n < 4; n += 1) {
        await complete(player.id, quest);
      }
      const first = await asPlayer(player.token, `/v1/events/${event.id}/activity?limit=3`);
      expect(first.statusCode).toBe(200);
      const page = first.json<{ entries: Row[]; nextCursor: string | null }>();
      expect(page.entries).toHaveLength(3);
      expect(page.entries[0]).toMatchObject({
        kind: "quest",
        scoreDelta: 10,
        balanceDelta: 10,
        reason: { type: "quest", questId: quest, title: { ar: null, en: "Find the word" } },
      });
      expect(page.nextCursor).toBe(page.entries[2]?.["id"]);
      const rest = (
        await asPlayer(
          player.token,
          `/v1/events/${event.id}/activity?limit=3&cursor=${page.nextCursor}`,
        )
      ).json<{ entries: Row[]; nextCursor: string | null }>();
      expect(rest.entries).toHaveLength(1);
      expect(rest.nextCursor).toBeNull();
    });

    it("refuses a malformed cursor or limit", async () => {
      const event = await newEvent();
      const player = await newPlayer(event.id);
      for (const query of [
        "cursor=abc",
        "cursor=0",
        "cursor=-1",
        "cursor=9999999999999999999",
        "limit=0",
        "limit=101",
        "extra=1",
      ]) {
        expect(
          (await asPlayer(player.token, `/v1/events/${event.id}/activity?${query}`)).statusCode,
        ).toBe(400);
      }
    });

    it("tells a pending member to wait and refuses everyone else", async () => {
      const event = await newEvent();
      const pending = await newPlayer(event.id, "pending");
      expect(
        (await asPlayer(pending.token, `/v1/events/${event.id}/activity`)).json(),
      ).toMatchObject({
        code: "membership_pending",
      });
      for (const status of ["left", "removed", "banned"]) {
        const player = await newPlayer(event.id, status);
        const answer = await asPlayer(player.token, `/v1/events/${event.id}/activity`);
        expect(answer.statusCode).toBe(403);
        expect(answer.json()).toMatchObject({ code: "not_enrolled" });
      }
      const stranger = await newPlayer(null);
      expect((await asPlayer(stranger.token, `/v1/events/${event.id}/activity`)).statusCode).toBe(
        403,
      );
      expect(
        (await asPlayer(stranger.token, `/v1/events/${randomUUID()}/activity`)).statusCode,
      ).toBe(403);
    });
  });

  describe("PUT /v1/organizers/:organizerId/events/:eventId/focus", () => {
    it("pins and clears, shows the pin in the builder, and audits each change once", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const set = await pin(event.id, quest);
      expect(set.statusCode).toBe(200);
      expect(set.json()).toEqual({ focusQuestId: quest });
      expect(await focusOf(event.id)).toBe(quest);
      const builder = await test.app.inject({
        method: "GET",
        url: `/v1/organizers/${organizer}/events/${event.id}/quests`,
        headers: withSession(cookie),
      });
      expect(builder.json()).toMatchObject({ focusQuestId: quest });
      expect((await pin(event.id, quest)).statusCode).toBe(200);
      expect((await pin(event.id, null)).json()).toEqual({ focusQuestId: null });
      expect(await focusOf(event.id)).toBeNull();
      const audit = await owner<{ before: Row; after: Row }>(
        "SELECT before, after FROM audit_log WHERE event_id = $1 AND action = 'event.focus_set' ORDER BY id",
        [event.id],
      );
      expect(audit).toEqual([
        { before: { focusQuestId: null }, after: { focusQuestId: quest } },
        { before: { focusQuestId: quest }, after: { focusQuestId: null } },
      ]);
    });

    it("lets a hidden quest be pinned", async () => {
      const event = await newEvent();
      const hidden = await newQuest(event, { visible: false });
      expect((await pin(event.id, hidden)).statusCode).toBe(200);
    });

    it("answers not found for another event's quest, an unknown quest, or another organizer's event", async () => {
      const event = await newEvent();
      const other = await newEvent();
      const theirs = await newQuest(other);
      expect((await pin(event.id, theirs)).statusCode).toBe(404);
      expect((await pin(event.id, randomUUID())).statusCode).toBe(404);
      const foreign = await newEvent({ org: otherOrganizer });
      const foreignQuest = await newQuest(foreign);
      expect((await pin(foreign.id, foreignQuest)).statusCode).toBe(404);
      expect((await pin(foreign.id, foreignQuest, otherOrganizer)).statusCode).toBe(404);
      expect(await focusOf(foreign.id)).toBeNull();
    });

    it("refuses an event that has ended", async () => {
      const event = await newEvent({ status: "live", startsIn: "-2 days", endsIn: "-1 day" });
      const quest = await newQuest(event);
      const answer = await pin(event.id, quest);
      expect(answer.statusCode).toBe(409);
      expect(answer.json()).toMatchObject({ code: "event_closed" });
    });

    it("takes exactly a quest id or null", async () => {
      const event = await newEvent();
      for (const payload of [{}, { questId: "nope" }, { questId: null, extra: 1 }]) {
        expect((await pin(event.id, null, organizer, payload)).statusCode).toBe(400);
      }
    });
  });

  describe("the event's configuration for a player (T-117)", () => {
    const TERMS = {
      currency: {
        icon: "gem",
        ar: { one: "جوهرة", many: "جواهر" },
        en: { one: "gem", many: "gems" },
      },
    };

    it("gives a member the event's words even when the event is unlisted, and an ETag", async () => {
      const event = await newEvent();
      await owner("UPDATE event SET access = 'unlisted', config = $2 WHERE id = $1", [
        event.id,
        JSON.stringify({ terms: TERMS }),
      ]);
      const player = await newPlayer(event.id);
      const config = await asPlayer(player.token, `/v1/events/${event.id}/config`);
      expect(config.statusCode).toBe(200);
      expect(config.json<{ terms: { currency: unknown } }>().terms.currency).toStrictEqual(
        TERMS.currency,
      );
      const again = await test.app.inject({
        method: "GET",
        url: `/v1/events/${event.id}/config`,
        headers: {
          authorization: `Bearer ${player.token}`,
          "if-none-match": String(config.headers["etag"]),
        },
      });
      expect(again.statusCode).toBe(304);
      const anyone = await test.app.inject({ method: "GET", url: `/v1/config?event=${event.id}` });
      expect(anyone.statusCode).toBe(404);
    });

    it("answers 404 to a player outside the event, and 401 without a session", async () => {
      const event = await newEvent();
      await owner("UPDATE event SET access = 'private' WHERE id = $1", [event.id]);
      const stranger = await newPlayer(null);
      expect((await asPlayer(stranger.token, `/v1/events/${event.id}/config`)).statusCode).toBe(
        404,
      );
      const member = await newPlayer(event.id);
      expect((await asPlayer(member.token, `/v1/events/${event.id}/config`)).statusCode).toBe(200);
      // The member's reading is cached for them alone: the stranger still gets 404.
      expect((await asPlayer(stranger.token, `/v1/events/${event.id}/config`)).statusCode).toBe(
        404,
      );
      const none = await test.app.inject({ method: "GET", url: `/v1/events/${event.id}/config` });
      expect(none.statusCode).toBe(401);
    });
  });
});
