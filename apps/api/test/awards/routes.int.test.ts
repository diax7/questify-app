import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
 * Manual awards over HTTP (T-207): the operator's find, form and award; the dashboard's award, a player's record,
 * removal, the report, the caps and bulk awards, with every refusal's answer.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("manual awards over HTTP", () => {
  let db: TestDatabase;
  let test: TestApp;
  let organizer = "";
  let ownerCookie = "";
  let editorCookie = "";
  let counter = 0;

  beforeAll(async () => {
    db = await createTestDatabase();
    test = await startApp(db);
    organizer =
      (
        await db.owner.query<{ id: string }>(
          "INSERT INTO organizer (name, slug) VALUES ('award-org', 'award-org') RETURNING id",
        )
      ).rows[0]?.id ?? "";
    for (const [email, role] of [
      ["owner@award.test", "owner"],
      ["editor@award.test", "editor"],
    ] as const) {
      const id = await createStaff(db.owner, { email });
      await db.owner.query(
        "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, $3)",
        [organizer, id, role],
      );
    }
    ownerCookie = await signInFully(test, "owner@award.test");
    editorCookie = await signInFully(test, "editor@award.test");
  });
  afterAll(async () => {
    await test.close();
    await db.close();
  });

  const owner = async <T extends Row>(sql: string, values: unknown[] = []) =>
    (await db.owner.query<T>(sql, values)).rows;

  const newEvent = async (): Promise<string> => {
    counter += 1;
    const [event] = await owner<{ id: string }>(
      `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at, award_cap_each, award_cap_day)
       VALUES ($1, $2, 'Award Fest', 'live', now() - interval '1 hour', now() + interval '1 day', 100, 150)
       RETURNING id`,
      [organizer, `AWDH${counter}`],
    );
    return event?.id ?? "";
  };

  const newQuest = async (event: string, points = 30) =>
    (
      await owner<{ id: string }>(
        `INSERT INTO quest (event_id, category_id, type, title_en, points)
         SELECT $1, id, 'scan_qr', 'Treasure', $2 FROM category WHERE event_id = $1 LIMIT 1 RETURNING id`,
        [event, points],
      )
    )[0]?.id ?? "";

  /** A signed-in player, enrolled when an event is given. */
  const newPlayer = async (event?: string, phone?: string) => {
    counter += 1;
    const username = `Award_${counter}`;
    const [player] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [username],
    );
    const id = player?.id ?? "";
    if (phone !== undefined) {
      await owner("INSERT INTO player_contact (player_id, phone_e164) VALUES ($1, $2)", [
        id,
        phone,
      ]);
    }
    const token = randomBytes(32).toString("base64url");
    await owner(
      "INSERT INTO player_session (player_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
      [id, createHash("sha256").update(token).digest()],
    );
    let enrollment = "";
    if (event !== undefined) {
      const [enrolled] = await owner<{ id: string }>(
        "INSERT INTO enrollment (organizer_id, event_id, player_id) VALUES ($1, $2, $3) RETURNING id",
        [organizer, event, id],
      );
      enrollment = enrolled?.id ?? "";
    }
    return { id, token, username, enrollment };
  };

  const newOperator = async (event: string, abilities = ["award"]) => {
    const person = await newPlayer(event);
    await owner(
      "INSERT INTO staff_assignment (organizer_id, event_id, player_id, abilities, can_play) VALUES ($1, $2, $3, $4, true)",
      [organizer, event, person.id, abilities],
    );
    return person;
  };

  const app = (
    method: "GET" | "POST",
    path: string,
    token: string,
    payload?: object,
    key = randomUUID(),
  ) =>
    test.app.inject({
      method,
      url: path,
      headers: { authorization: `Bearer ${token}`, "idempotency-key": key },
      ...(payload === undefined ? {} : { payload }),
    });

  const dashboard = (
    method: "GET" | "PUT" | "POST",
    path: string,
    payload?: object,
    cookie = ownerCookie,
    key = randomUUID(),
  ) =>
    test.app.inject({
      method,
      url: `/v1/organizers/${organizer}${path}`,
      headers: withSession(cookie, { "idempotency-key": key }),
      ...(payload === undefined ? {} : { payload }),
    });

  describe("operator mode", () => {
    it("finds a member by username or phone and says when there is none", async () => {
      const event = await newEvent();
      const operator = await newOperator(event);
      const sara = await newPlayer(event, "+966500000301");
      const find = (query: string) =>
        app("POST", `/v1/operator/events/${event}/find-player`, operator.token, { query });
      expect((await find(`@${sara.username.toLowerCase()}`)).json()).toEqual({
        player: {
          enrollmentId: sara.enrollment,
          username: sara.username,
          avatar: expect.any(String),
          active: true,
        },
      });
      expect((await find("0500000301")).json<{ player: Row }>().player["enrollmentId"]).toBe(
        sara.enrollment,
      );
      expect((await find("nobody_at_all")).json()).toEqual({ player: null });
    });

    it("limits finds to 30 in 10 minutes", async () => {
      const event = await newEvent();
      const operator = await newOperator(event);
      for (let index = 0; index < 30; index += 1) {
        await app("POST", `/v1/operator/events/${event}/find-player`, operator.token, {
          query: "x_y",
        });
      }
      const refused = await app(
        "POST",
        `/v1/operator/events/${event}/find-player`,
        operator.token,
        {
          query: "x_y",
        },
      );
      expect(refused.statusCode).toBe(429);
      expect(refused.headers["retry-after"]).toBeDefined();
    });

    it("answers the form, awards points and replays a retry", async () => {
      const event = await newEvent();
      const quest = await newQuest(event, 30);
      const operator = await newOperator(event);
      const sara = await newPlayer(event);
      const form = await app("GET", `/v1/operator/events/${event}/award`, operator.token);
      expect(form.json()).toEqual({
        capEach: 100,
        capDay: 150,
        leftToday: 150,
        live: true,
        quests: [{ id: quest, title: { ar: null, en: "Treasure" }, points: 30 }],
      });
      const key = randomUUID();
      const body = { eventId: event, enrollmentId: sara.enrollment, points: 60, reason: "Torn QR" };
      const first = await app("POST", "/v1/operator/award", operator.token, body, key);
      expect(first.statusCode).toBe(200);
      expect(first.json()).toEqual({ points: 60, replayed: false });
      expect((await app("POST", "/v1/operator/award", operator.token, body, key)).statusCode).toBe(
        200,
      );
      const viaQuest = await app("POST", "/v1/operator/award", operator.token, {
        eventId: event,
        enrollmentId: sara.enrollment,
        questId: quest,
        reason: "Scanner broke",
      });
      expect(viaQuest.json()).toEqual({ points: 30, replayed: false });
    });

    it("answers every refusal", async () => {
      const event = await newEvent();
      const operator = await newOperator(event);
      const off = await newOperator(event, ["scan_quests"]);
      const sara = await newPlayer(event);
      const award = (token: string, body: Row) =>
        app("POST", "/v1/operator/award", token, {
          eventId: event,
          enrollmentId: sara.enrollment,
          ...body,
        });
      const overEach = await award(operator.token, { points: 101, reason: "x" });
      expect(overEach.statusCode).toBe(409);
      expect(overEach.json()).toMatchObject({
        code: "over_cap",
        details: { cap: "each", limit: 100, left: 150 },
      });
      await award(operator.token, { points: 100, reason: "x" });
      expect((await award(operator.token, { points: 60, reason: "x" })).json()).toMatchObject({
        code: "over_cap",
        details: { cap: "day", limit: 150, left: 50 },
      });
      const empty = await award(operator.token, { points: 5, reason: "  " });
      expect([empty.statusCode, empty.json<Row>()["code"]]).toEqual([400, "reason_required"]);
      expect((await award(off.token, { points: 5, reason: "x" })).json()).toMatchObject({
        code: "ability_off",
      });
      const self = await app("POST", "/v1/operator/award", operator.token, {
        eventId: event,
        enrollmentId: operator.enrollment,
        points: 5,
        reason: "x",
      });
      expect([self.statusCode, self.json<Row>()["code"]]).toEqual([403, "self_award"]);
      const stranger = await newPlayer();
      expect((await award(stranger.token, { points: 5, reason: "x" })).json()).toMatchObject({
        code: "not_operator",
      });
      const both = await award(operator.token, { points: 5, questId: randomUUID(), reason: "x" });
      expect(both.statusCode).toBe(400);
    });
  });

  describe("the dashboard", () => {
    it("awards, lists the record, removes once and reports", async () => {
      const event = await newEvent();
      const sara = await newPlayer(event);
      const awarded = await dashboard(
        "POST",
        `/events/${event}/players/${sara.enrollment}/awards`,
        {
          points: 500,
          reason: "Keynote winner",
        },
      );
      expect(awarded.statusCode).toBe(201);
      const { entryId } = awarded.json<{ entryId: string }>();
      const record = await dashboard("GET", `/events/${event}/players/${sara.enrollment}/entries`);
      expect(record.json<{ entries: Row[] }>().entries[0]).toMatchObject({
        id: entryId,
        kind: "award",
        scoreDelta: 500,
        reason: "Keynote winner",
        by: { operator: null, staff: "owner@award.test" },
        removable: true,
      });
      const removed = await dashboard(
        "POST",
        `/events/${event}/entries/${entryId}/remove`,
        { reason: "Wrong player" },
        editorCookie,
      );
      expect(removed.json()).toMatchObject({
        scoreDelta: -500,
        balanceDelta: -500,
        replayed: false,
      });
      const again = await dashboard("POST", `/events/${event}/entries/${entryId}/remove`, {
        reason: "x",
      });
      expect([again.statusCode, again.json<Row>()["code"]]).toEqual([409, "already_removed"]);
      const report = await dashboard("GET", `/events/${event}/awards`);
      expect(report.json<Row>()).toMatchObject({
        caps: { each: 100, day: 150 },
        awards: [
          {
            kind: "removal",
            points: 500,
            reason: "Wrong player",
            player: { username: sara.username },
          },
          { kind: "award", points: 500, removed: true },
        ],
        nextCursor: null,
      });
    });

    it("caps an editor's award and refuses what cannot be removed", async () => {
      const event = await newEvent();
      const sara = await newPlayer(event);
      const over = await dashboard(
        "POST",
        `/events/${event}/players/${sara.enrollment}/awards`,
        { points: 101, reason: "x" },
        editorCookie,
      );
      expect(over.json()).toMatchObject({ code: "over_cap", details: { cap: "each" } });
      const unknown = await dashboard("POST", `/events/${event}/entries/999999999/remove`, {
        reason: "x",
      });
      expect(unknown.statusCode).toBe(404);
      const bad = await dashboard("POST", `/events/${event}/entries/abc/remove`, { reason: "x" });
      expect(bad.statusCode).toBe(400);
    });

    it("pages the report with a cursor", async () => {
      const event = await newEvent();
      const sara = await newPlayer(event);
      for (let index = 0; index < 3; index += 1) {
        await dashboard("POST", `/events/${event}/players/${sara.enrollment}/awards`, {
          points: 1,
          reason: "x",
        });
      }
      const first = (await dashboard("GET", `/events/${event}/awards?limit=2`)).json<{
        awards: Row[];
        nextCursor: string;
      }>();
      expect(first.awards).toHaveLength(2);
      const second = (
        await dashboard(
          "GET",
          `/events/${event}/awards?limit=2&cursor=${encodeURIComponent(first.nextCursor)}`,
        )
      ).json<{ awards: Row[]; nextCursor: string | null }>();
      expect(second).toMatchObject({ nextCursor: null });
      expect(second.awards).toHaveLength(1);
      expect((await dashboard("GET", `/events/${event}/awards?cursor=junk`)).statusCode).toBe(400);
    });

    it("lets the owner set the caps and refuses an editor or a bad pair", async () => {
      const event = await newEvent();
      const saved = await dashboard("PUT", `/events/${event}/award-caps`, { each: 50, day: 400 });
      expect(saved.json()).toEqual({ each: 50, day: 400 });
      const editor = await dashboard(
        "PUT",
        `/events/${event}/award-caps`,
        { each: 1, day: 1 },
        editorCookie,
      );
      expect([editor.statusCode, editor.json<Row>()["code"]]).toEqual([403, "owner_only"]);
      expect(
        (await dashboard("PUT", `/events/${event}/award-caps`, { each: 50, day: 40 })).statusCode,
      ).toBe(400);
    });

    it("previews and awards a list, and a quest's completers", async () => {
      const event = await newEvent();
      const quest = await newQuest(event, 10);
      const sara = await newPlayer(event, "+966500000302");
      const omar = await newPlayer(event);
      const banned = await newPlayer(event);
      await owner("UPDATE enrollment SET status = 'banned' WHERE id = $1", [banned.enrollment]);
      const preview = await dashboard("POST", `/events/${event}/bulk-awards/preview`, {
        lines: `0500000302\n@${omar.username}, ${banned.username}\n\nghost_user`,
      });
      expect(preview.json()).toEqual({
        matched: expect.arrayContaining([
          { enrollmentId: sara.enrollment, username: sara.username },
          { enrollmentId: omar.enrollment, username: omar.username },
        ]),
        inactive: [banned.username],
        notFound: ["ghost_user"],
        count: 2,
      });
      const done = await dashboard(
        "POST",
        `/events/${event}/bulk-awards`,
        {
          enrollmentIds: [sara.enrollment, omar.enrollment, banned.enrollment],
          points: 50,
          reason: "Code failed",
        },
        editorCookie,
      );
      expect(done.statusCode).toBe(201);
      expect(done.json()).toMatchObject({ awarded: 2, skipped: 1, replayed: false });

      await dashboard("POST", `/events/${event}/players/${sara.enrollment}/awards`, {
        questId: quest,
        reason: "x",
      });
      const count = await dashboard("POST", `/events/${event}/bulk-awards/preview`, {
        questId: quest,
      });
      expect(count.json()).toEqual({ count: 1 });
      const byQuest = await dashboard("POST", `/events/${event}/bulk-awards`, {
        questId: quest,
        points: 5,
        reason: "Bonus",
      });
      expect(byQuest.json()).toMatchObject({ awarded: 1, skipped: 0 });
    });

    it("refuses a list over 2000 lines and an editor's bulk over the per-award cap", async () => {
      const event = await newEvent();
      const lines = Array.from({ length: 2001 }, (_, index) => `user_${index}`).join("\n");
      const tooLong = await dashboard("POST", `/events/${event}/bulk-awards/preview`, { lines });
      expect([tooLong.statusCode, tooLong.json<Row>()["code"]]).toEqual([400, "too_many_lines"]);
      const sara = await newPlayer(event);
      const over = await dashboard(
        "POST",
        `/events/${event}/bulk-awards`,
        { enrollmentIds: [sara.enrollment], points: 101, reason: "x" },
        editorCookie,
      );
      expect(over.json()).toMatchObject({ code: "over_cap" });
    });
  });
});
