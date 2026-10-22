import { createHash, randomBytes, randomUUID } from "node:crypto";
import { joinCard } from "@questify/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMyCodeKey, myCode } from "#src/quests/qr";
import {
  createStaff,
  signInFully,
  startApp,
  withSession,
  type TestApp,
} from "#test/support/auth-app";
import { TEST_DATABASE_URL, createTestDatabase, type TestDatabase } from "#test/support/test-db";

type Row = Record<string, unknown>;

/** The test config's QR secret (test/support/auth-app.ts), so a test can show a real My QR. */
const MY_KEY = createMyCodeKey("q".repeat(40));

/** The signed token in a claim address's fragment. */
const tokenOf = (url: unknown) => String(url).split("#")[1] ?? "";

/**
 * Operators over HTTP (T-204, T-205): the owner's invites and management, the claim, the station scan with its three
 * results, removal at once, playing when allowed, and My QR.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("operators over HTTP", () => {
  let db: TestDatabase;
  let test: TestApp;
  let organizer: string;
  let ownerCookie: string;
  let editorCookie: string;
  let counter = 0;

  beforeAll(async () => {
    db = await createTestDatabase();
    test = await startApp(db);
    organizer =
      (
        await db.owner.query<{ id: string }>(
          "INSERT INTO organizer (name, slug) VALUES ('ops-org', 'ops-org') RETURNING id",
        )
      ).rows[0]?.id ?? "";
    const ownerId = await createStaff(db.owner, { email: "owner@ops.test" });
    const editorId = await createStaff(db.owner, { email: "editor@ops.test" });
    await db.owner.query(
      "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'editor')",
      [organizer, ownerId, editorId],
    );
    ownerCookie = await signInFully(test, "owner@ops.test");
    editorCookie = await signInFully(test, "editor@ops.test");
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
      `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at)
       VALUES ($1, $2, 'Ops Fest', 'live', now() - interval '1 hour', now() + interval '1 day') RETURNING id`,
      [organizer, `OPS${counter}`],
    );
    return event?.id ?? "";
  };

  const newQuest = async (event: string, verification = ["quest_qr", "my_qr"]) =>
    (
      await owner<{ id: string }>(
        `INSERT INTO quest (event_id, category_id, type, title_en, points, verification)
         SELECT $1, id, 'scan_qr', 'Gate', 25, $2 FROM category WHERE event_id = $1 RETURNING id`,
        [event, verification],
      )
    )[0]?.id ?? "";

  /** A signed-in player; enrolled in the event when one is given. */
  const newPlayer = async (event?: string, email?: string) => {
    counter += 1;
    const [player] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`ops_${counter}`],
    );
    const id = player?.id ?? "";
    await owner("INSERT INTO player_contact (player_id, email) VALUES ($1, $2)", [
      id,
      email ?? `ops${counter}@x.sa`,
    ]);
    const token = randomBytes(32).toString("base64url");
    await owner(
      "INSERT INTO player_session (player_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
      [id, createHash("sha256").update(token).digest()],
    );
    if (event !== undefined) {
      await owner(
        "INSERT INTO enrollment (organizer_id, event_id, player_id) VALUES ($1, $2, $3)",
        [organizer, event, id],
      );
    }
    return { id, token };
  };

  const dashboard = (
    method: "GET" | "PUT" | "POST" | "DELETE",
    path: string,
    payload?: object,
    cookie = ownerCookie,
  ) =>
    test.app.inject({
      method,
      url: `/v1/organizers/${organizer}${path}`,
      headers: withSession(cookie, { "idempotency-key": randomUUID() }),
      ...(payload === undefined ? {} : { payload }),
    });

  const app = (
    method: "GET" | "POST",
    path: string,
    token: string,
    payload?: object,
    key: string = randomUUID(),
  ) =>
    test.app.inject({
      method,
      url: path,
      headers: { authorization: `Bearer ${token}`, "idempotency-key": key },
      ...(payload === undefined ? {} : { payload }),
    });

  /** A personal invite claimed by a new player: they are the event's operator. */
  const newOperator = async (event: string, preset = "scanner") => {
    const made = await dashboard("POST", `/events/${event}/operators/invites`, {
      kind: "personal",
      label: "Gate crew",
      preset,
    });
    const [id] = made.json<{ ids: string[] }>().ids;
    const list = await dashboard("GET", `/events/${event}/operators?lang=en`);
    const invite = list.json<{ invites: Row[] }>().invites.find((row) => row["id"] === id);
    const person = await newPlayer();
    const claimed = await app("POST", "/v1/operator-invites/claim", person.token, {
      token: tokenOf(invite?.["url"]),
    });
    expect(claimed.statusCode).toBe(200);
    const operators = (await dashboard("GET", `/events/${event}/operators`)).json<{
      operators: Row[];
    }>().operators;
    const assignment = operators.find((row) => row["playerId"] === person.id);
    return { ...person, assignment: String(assignment?.["id"]) };
  };

  describe("invites and management", () => {
    it("lets the owner invite and print, editors only read, with no claim address", async () => {
      const event = await newEvent();
      const made = await dashboard("POST", `/events/${event}/operators/invites`, {
        kind: "batch",
        label: "Crew",
        count: 3,
        preset: "scanner",
      });
      expect(made.statusCode).toBe(201);
      expect(made.json<{ ids: string[] }>().ids).toHaveLength(3);
      const ownerList = (await dashboard("GET", `/events/${event}/operators?lang=en`)).json<{
        invites: Row[];
      }>();
      expect(ownerList.invites).toHaveLength(3);
      expect(String(ownerList.invites[0]?.["url"])).toMatch(
        /^https:\/\/app\.questify\.test\/en\/op#[A-Za-z0-9_-]{50}$/,
      );
      expect(ownerList.invites[0]).toMatchObject({
        kind: "personal",
        status: "open",
        abilities: ["scan_quests"],
      });

      const editorList = await dashboard(
        "GET",
        `/events/${event}/operators`,
        undefined,
        editorCookie,
      );
      expect(editorList.statusCode).toBe(200);
      expect(editorList.body).not.toContain("/op#");
      const byEditor = await dashboard(
        "POST",
        `/events/${event}/operators/invites`,
        { kind: "personal", label: "Mine" },
        editorCookie,
      );
      expect(byEditor.statusCode).toBe(403);
      expect(byEditor.json()).toMatchObject({ code: "owner_only" });
      expect(
        (
          await dashboard("POST", `/events/${event}/operators/invites`, {
            kind: "batch",
            label: "x",
            count: 101,
          })
        ).statusCode,
      ).toBe(400);
      expect((await dashboard("GET", `/events/${randomUUID()}/operators`)).statusCode).toBe(404);
    });

    it("emails an invite with its claim link and shows the email masked", async () => {
      const event = await newEvent();
      const made = await dashboard("POST", `/events/${event}/operators/invites`, {
        kind: "email",
        email: " Lead@Najd.SA ",
        lang: "en",
      });
      expect(made.statusCode).toBe(201);
      const [mail] = test.mail.to("lead@najd.sa");
      expect(mail?.text).toMatch(/https:\/\/app\.questify\.test\/en\/op#[A-Za-z0-9_-]{50}/);
      expect(mail?.text).not.toContain("Ops Fest");
      const list = (await dashboard("GET", `/events/${event}/operators`)).json<{
        invites: Row[];
      }>();
      expect(list.invites[0]).toMatchObject({ kind: "email", email: "l•••@najd.sa" });
      expect(list.invites[0]).not.toHaveProperty("url");
      expect(
        (
          await dashboard("POST", `/events/${event}/operators/invites`, {
            kind: "email",
            email: "nope",
          })
        ).json(),
      ).toMatchObject({ code: "invalid_operator", details: { field: "email" } });
    });

    it("revokes an email invite that could not be sent", async () => {
      const event = await newEvent();
      test.mail.failing = true;
      try {
        const made = await dashboard("POST", `/events/${event}/operators/invites`, {
          kind: "email",
          email: "lost@najd.sa",
        });
        expect(made.statusCode).toBe(503);
      } finally {
        test.mail.failing = false;
      }
      const list = (await dashboard("GET", `/events/${event}/operators`)).json<{
        invites: Row[];
      }>();
      expect(list.invites).toMatchObject([{ status: "revoked", email: null }]);
    });

    it("previews and claims once, and refuses forged, used and revoked codes", async () => {
      const event = await newEvent();
      const made = await dashboard("POST", `/events/${event}/operators/invites`, {
        kind: "personal",
        label: "Noura",
        preset: "prize_desk",
      });
      const [id] = made.json<{ ids: string[] }>().ids;
      const url = (await dashboard("GET", `/events/${event}/operators`)).json<{ invites: Row[] }>()
        .invites[0]?.["url"];
      const token = tokenOf(url);
      const person = await newPlayer();
      const preview = await app("POST", "/v1/operator-invites/preview", person.token, { token });
      expect(preview.json()).toEqual({
        event: { id: event, name: { ar: null, en: "Ops Fest" } },
        abilities: ["hand_over"],
      });
      expect(
        (await app("POST", "/v1/operator-invites/claim", person.token, { token })).json(),
      ).toEqual({ eventId: event });
      const other = await newPlayer();
      const used = await app("POST", "/v1/operator-invites/claim", other.token, { token });
      expect(used.statusCode).toBe(409);
      expect(used.json()).toMatchObject({ code: "invite_used" });
      const forged = await app("POST", "/v1/operator-invites/preview", other.token, {
        token: `${token.slice(0, 49)}${token.endsWith("A") ? "B" : "A"}`,
      });
      expect(forged.statusCode).toBe(404);
      expect(
        (await app("POST", "/v1/operator-invites/preview", other.token, { token: "x" })).statusCode,
      ).toBe(404);
      const list = (await dashboard("GET", `/events/${event}/operators`)).json<{
        operators: Row[];
        invites: Row[];
      }>();
      expect(list.invites[0]).toMatchObject({
        id,
        status: "claimed",
        claimedBy: { username: expect.any(String) },
      });
      expect(list.invites[0]).not.toHaveProperty("url");
      expect(list.operators[0]).toMatchObject({ claimedVia: { inviteId: id, label: "Noura" } });
      expect(
        (await app("POST", "/v1/operator-invites/claim", other.token, { token })).statusCode,
      ).toBe(409);
    });

    it("changes abilities, may-play and the quest limit, and removes an operator", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const { assignment } = await newOperator(event);
      const set = (payload: object, cookie = ownerCookie) =>
        dashboard("PUT", `/events/${event}/operators/${assignment}`, payload, cookie);
      expect(
        (
          await set({ abilities: ["scan_quests", "award"], canPlay: true, questIds: [quest] })
        ).json(),
      ).toEqual({
        operator: {
          id: assignment,
          abilities: ["scan_quests", "award"],
          canPlay: true,
          questIds: [quest],
        },
      });
      expect(
        (await set({ abilities: [], canPlay: false, questIds: [randomUUID()] })).statusCode,
      ).toBe(422);
      expect((await set({ abilities: ["fly"], canPlay: false, questIds: [] })).statusCode).toBe(
        400,
      );
      expect(
        (await set({ abilities: [], canPlay: false, questIds: [] }, editorCookie)).statusCode,
      ).toBe(403);
      expect(
        (await dashboard("DELETE", `/events/${event}/operators/${assignment}`)).statusCode,
      ).toBe(204);
      expect(
        (await dashboard("DELETE", `/events/${event}/operators/${assignment}`)).statusCode,
      ).toBe(404);
    });
  });

  describe("the station", () => {
    it("lists the operator's events and stations, scans green, then orange, never showing a balance", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      await newQuest(event, ["quest_qr"]);
      const operator = await newOperator(event);
      const events = (await app("GET", "/v1/me/operator-events", operator.token)).json<{
        events: Row[];
      }>().events;
      expect(events).toMatchObject([
        {
          eventId: event,
          statusNow: "live",
          abilities: ["scan_quests"],
          canPlay: false,
          enrollmentStatus: null,
        },
      ]);
      const stations = await app("GET", `/v1/operator/events/${event}/stations`, operator.token);
      expect(stations.json()).toMatchObject({
        stations: [{ questId: quest, points: 25, doneToday: 0, doneTotal: 0 }],
      });

      const player = await newPlayer(event);
      const code = myCode(MY_KEY, player.id, 1);
      const green = await app("POST", "/v1/operator/scan", operator.token, {
        questId: quest,
        code,
      });
      expect(green.statusCode).toBe(200);
      expect(green.json()).toEqual({
        result: "completed",
        player: { username: expect.stringMatching(/^ops_/), avatar: "falcon" },
        points: 25,
        occurrence: 1,
        replayed: false,
      });
      expect(green.body).not.toMatch(/score|balance/);
      const orange = await app("POST", "/v1/operator/scan", operator.token, {
        questId: quest,
        code,
      });
      expect(orange.json()).toMatchObject({
        result: "already_completed",
        player: { avatar: "falcon" },
      });
      expect(
        (await app("GET", `/v1/operator/events/${event}/stations`, operator.token)).json(),
      ).toMatchObject({ stations: [{ doneToday: 1, doneTotal: 1 }] });
      const [score] = await owner<{ score: string }>(
        "SELECT score FROM enrollment WHERE event_id = $1 AND player_id = $2",
        [event, player.id],
      );
      expect(score?.score).toBe("25");
    });

    it("shows red with a reason, and no name for someone outside the event or a bad code", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const operator = await newOperator(event);
      const stranger = await newPlayer();
      const scan = (code: string, questId = quest) =>
        app("POST", "/v1/operator/scan", operator.token, { questId, code }).then((response) =>
          response.json<Row>(),
        );
      expect(await scan("not a code")).toEqual({
        result: "refused",
        reason: "invalid_code",
        player: null,
      });
      expect(await scan(myCode(MY_KEY, stranger.id, 1))).toEqual({
        result: "refused",
        reason: "not_in_event",
        player: null,
      });
      expect(await scan(myCode(MY_KEY, operator.id, 1))).toMatchObject({
        result: "refused",
        reason: "self_scan",
      });
      const member = await newPlayer(event);
      expect(await scan(myCode(MY_KEY, member.id, 9))).toMatchObject({
        result: "refused",
        reason: "old_code",
        player: { avatar: "falcon" },
      });
      expect(await scan(myCode(MY_KEY, member.id, 1), randomUUID())).toEqual({
        result: "refused",
        reason: "quest_not_found",
        player: null,
      });
    });

    it("refuses a removed operator at once with 403 not_operator", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const operator = await newOperator(event);
      const player = await newPlayer(event);
      await dashboard("DELETE", `/events/${event}/operators/${operator.assignment}`);
      const scan = await app("POST", "/v1/operator/scan", operator.token, {
        questId: quest,
        code: myCode(MY_KEY, player.id, 1),
      });
      expect(scan.statusCode).toBe(403);
      expect(scan.json()).toMatchObject({ code: "not_operator" });
      expect(
        (await app("GET", `/v1/operator/events/${event}/stations`, operator.token)).statusCode,
      ).toBe(403);
    });

    it("lets an operator play only when allowed, with the join card in force", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const operator = await newOperator(event);
      const play = (cardVersion = joinCard().version) =>
        app("POST", `/v1/events/${event}/operator/play`, operator.token, { cardVersion });
      expect((await play()).json()).toMatchObject({ code: "operator_play_off" });
      await dashboard("PUT", `/events/${event}/operators/${operator.assignment}`, {
        abilities: ["scan_quests"],
        canPlay: true,
        questIds: [],
      });
      expect((await play("0.0.1")).json()).toMatchObject({ code: "card_version_stale" });
      expect((await play()).statusCode).toBe(200);
      const own = await app("POST", `/v1/quests/${quest}/complete`, operator.token, {
        proof: { type: "qr", code: "x".repeat(50) },
      });
      expect(own.statusCode).toBe(422);
      await dashboard("PUT", `/events/${event}/operators/${operator.assignment}`, {
        abilities: ["scan_quests"],
        canPlay: false,
        questIds: [],
      });
      const colleague = await newOperator(event);
      expect(
        (
          await app("POST", "/v1/operator/scan", colleague.token, {
            questId: quest,
            code: myCode(MY_KEY, operator.id, 1),
          })
        ).json(),
      ).toMatchObject({ result: "refused", reason: "operator_not_playing" });
    });

    it("takes a seat when an operator plays, so a full hard limit answers 409 event_full", async () => {
      const event = await newEvent();
      await newPlayer(event);
      await owner("UPDATE event SET player_limit_mode = 'hard', player_limit = 1 WHERE id = $1", [
        event,
      ]);
      const operator = await newOperator(event);
      await dashboard("PUT", `/events/${event}/operators/${operator.assignment}`, {
        abilities: ["scan_quests"],
        canPlay: true,
        questIds: [],
      });
      const play = await app("POST", `/v1/events/${event}/operator/play`, operator.token, {
        cardVersion: joinCard().version,
      });
      expect(play.statusCode).toBe(409);
      expect(play.json()).toMatchObject({ code: "event_full" });
    });
  });

  describe("My QR", () => {
    it("gives the player their fixed code and a new one on reset, the old one then refused", async () => {
      const event = await newEvent();
      const quest = await newQuest(event, ["my_qr"]);
      const operator = await newOperator(event);
      const player = await newPlayer(event);
      const first = (await app("GET", "/v1/me/qr", player.token)).json<{ token: string }>().token;
      expect(first).toBe(myCode(MY_KEY, player.id, 1));
      expect((await app("GET", "/v1/me/qr", player.token)).json()).toEqual({ token: first });
      const reset = await app("POST", "/v1/me/qr/reset", player.token);
      const second = reset.json<{ token: string }>().token;
      expect(second).toBe(myCode(MY_KEY, player.id, 2));
      expect(
        (
          await app("POST", "/v1/operator/scan", operator.token, { questId: quest, code: first })
        ).json(),
      ).toMatchObject({ result: "refused", reason: "old_code" });
      expect(
        (
          await app("POST", "/v1/operator/scan", operator.token, { questId: quest, code: second })
        ).json(),
      ).toMatchObject({ result: "completed" });
      expect((await app("GET", "/v1/me/qr", "x".repeat(43))).statusCode).toBe(401);
    });
  });
});
