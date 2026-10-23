import { createHash, randomBytes, randomUUID } from "node:crypto";
import { joinCard } from "@questify/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loggerOptions } from "#src/app";
import { createInviteCodeKey, createMyCodeKey, inviteCode, myCode } from "#src/quests/qr";
import {
  createStaff,
  signInFully,
  startApp,
  testConfig,
  withSession,
  type TestApp,
} from "#test/support/auth-app";
import { TEST_DATABASE_URL, createTestDatabase, type TestDatabase } from "#test/support/test-db";

type Row = Record<string, unknown>;

/** The test config's QR secret (test/support/auth-app.ts), so a test can make real codes. */
const SECRET = "q".repeat(40);
const MY_KEY = createMyCodeKey(SECRET);
const INVITE_KEY = createInviteCodeKey(SECRET);

/**
 * Every refusal of the operator routes over HTTP (T-204, T-205): the owner's management, the claim, playing, My QR
 * resets and each red reason at the station, with what the log keeps.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("operator refusals over HTTP", () => {
  let db: TestDatabase;
  let test: TestApp;
  let organizer: string;
  let ownerCookie: string;
  let editorCookie: string;
  let lines: string[] = [];
  let counter = 0;

  beforeAll(async () => {
    db = await createTestDatabase();
    test = await startApp(db, {
      ...loggerOptions(testConfig()),
      level: "info",
      stream: { write: (line: string) => void lines.push(line) },
    });
    organizer =
      (
        await db.owner.query<{ id: string }>(
          "INSERT INTO organizer (name, slug) VALUES ('refusal-org', 'refusal-org') RETURNING id",
        )
      ).rows[0]?.id ?? "";
    const ownerId = await createStaff(db.owner, { email: "owner@refusal.test" });
    const editorId = await createStaff(db.owner, { email: "editor@refusal.test" });
    await db.owner.query(
      "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'editor')",
      [organizer, ownerId, editorId],
    );
    ownerCookie = await signInFully(test, "owner@refusal.test");
    editorCookie = await signInFully(test, "editor@refusal.test");
  });
  afterAll(async () => {
    await test.close();
    await db.close();
  });
  beforeEach(() => {
    lines = [];
  });

  const owner = async <T extends Row>(sql: string, values: unknown[] = []) =>
    (await db.owner.query<T>(sql, values)).rows;

  const logged = (name: string): Row[] =>
    lines.map((line) => JSON.parse(line) as Row).filter((line) => line["event"] === name);

  const newEvent = async (status = "live"): Promise<string> => {
    counter += 1;
    const ends = status === "ended" ? "- interval '1 minute'" : "+ interval '1 day'";
    const [event] = await owner<{ id: string }>(
      `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at)
       VALUES ($1, $2, 'Refusal Fest', $3, now() - interval '1 hour', now() ${ends}) RETURNING id`,
      [organizer, `REF${counter}`, status],
    );
    return event?.id ?? "";
  };

  const newQuest = async (
    event: string,
    fields: { verification?: string[]; visible?: boolean } = {},
  ) =>
    (
      await owner<{ id: string }>(
        `INSERT INTO quest (event_id, category_id, type, title_en, points, verification, visible)
         SELECT $1, id, 'scan_qr', 'Gate', 25, $2, $3 FROM category WHERE event_id = $1 RETURNING id`,
        [event, fields.verification ?? ["quest_qr", "my_qr"], fields.visible ?? true],
      )
    )[0]?.id ?? "";

  const newPlayer = async (event?: string, status = "active", email?: string) => {
    counter += 1;
    const [player] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`ref_${counter}`],
    );
    const id = player?.id ?? "";
    await owner("INSERT INTO player_contact (player_id, email) VALUES ($1, $2)", [
      id,
      email ?? `ref${counter}@x.sa`,
    ]);
    const token = randomBytes(32).toString("base64url");
    await owner(
      "INSERT INTO player_session (player_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
      [id, createHash("sha256").update(token).digest()],
    );
    if (event !== undefined) {
      await owner(
        "INSERT INTO enrollment (organizer_id, event_id, player_id, status) VALUES ($1, $2, $3, $4)",
        [organizer, event, id, status],
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
    key = randomUUID(),
  ) =>
    test.app.inject({
      method,
      url: path,
      headers: { authorization: `Bearer ${token}`, "idempotency-key": key },
      ...(payload === undefined ? {} : { payload }),
    });

  /** An invite made by the owner, as its id and claim token. */
  const newInvite = async (
    event: string,
    payload: object = { kind: "personal", label: "Crew" },
  ) => {
    const [id = ""] = (
      await dashboard("POST", `/events/${event}/operators/invites`, payload)
    ).json<{
      ids: string[];
    }>().ids;
    return { id, token: inviteCode(INVITE_KEY, id) };
  };

  const newOperator = async (event: string, preset = "scanner") => {
    const invite = await newInvite(event, { kind: "personal", label: "Crew", preset });
    const person = await newPlayer();
    await app("POST", "/v1/operator-invites/claim", person.token, { token: invite.token });
    const [assignment] = await owner<{ id: string }>(
      "SELECT id FROM staff_assignment WHERE event_id = $1 AND player_id = $2",
      [event, person.id],
    );
    return { ...person, assignment: assignment?.id ?? "" };
  };

  describe("the owner's routes", () => {
    it("refuses invites for a missing or ended event, and past 500 open ones", async () => {
      const invite = { kind: "personal", label: "Crew" };
      expect(
        (await dashboard("POST", `/events/${randomUUID()}/operators/invites`, invite)).statusCode,
      ).toBe(404);
      const ended = await newEvent("ended");
      expect(
        (await dashboard("POST", `/events/${ended}/operators/invites`, invite)).json(),
      ).toMatchObject({
        code: "event_closed",
      });
      const event = await newEvent();
      for (let round = 0; round < 5; round += 1) {
        await dashboard("POST", `/events/${event}/operators/invites`, {
          kind: "batch",
          label: "Crew",
          count: 100,
        });
      }
      const full = await dashboard("POST", `/events/${event}/operators/invites`, invite);
      expect(full.statusCode).toBe(409);
      expect(full.json()).toMatchObject({ code: "operator_invites_full" });
    });

    it("checks the body: a known kind, a label of 1 to 56, a count for a batch, a known language", async () => {
      const event = await newEvent();
      for (const payload of [
        { kind: "badge", label: "Crew" },
        { kind: "personal", label: "x".repeat(57) },
        { kind: "personal", label: "   " },
        { kind: "batch", label: "Crew" },
        { kind: "personal", label: "Crew", preset: "boss" },
      ]) {
        expect(
          (await dashboard("POST", `/events/${event}/operators/invites`, payload)).statusCode,
        ).toBe(400);
      }
      expect((await dashboard("GET", `/events/${event}/operators?lang=fr`)).statusCode).toBe(400);
      expect((await dashboard("GET", `/events/x/operators`)).statusCode).toBe(400);
    });

    it("gives the claim address in the language asked, Arabic when none is", async () => {
      const event = await newEvent();
      await newInvite(event);
      const url = (lang: string) =>
        dashboard("GET", `/events/${event}/operators${lang}`).then(
          (response) => response.json<{ invites: Row[] }>().invites[0]?.["url"],
        );
      expect(await url("")).toMatch(/\/ar\/op#/);
      expect(await url("?lang=en")).toMatch(/\/en\/op#/);
    });

    it("cancels an open invite once, refuses editors and unknown ids", async () => {
      const event = await newEvent();
      const invite = await newInvite(event);
      const path = `/events/${event}/operators/invites/${invite.id}`;
      expect((await dashboard("DELETE", path, undefined, editorCookie)).json()).toMatchObject({
        code: "owner_only",
      });
      expect((await dashboard("DELETE", path)).statusCode).toBe(204);
      expect((await dashboard("DELETE", path)).json()).toMatchObject({ code: "invite_used" });
      expect(
        (await dashboard("DELETE", `/events/${event}/operators/invites/${randomUUID()}`))
          .statusCode,
      ).toBe(404);
    });

    it("refuses a change or removal by an editor, of an unknown operator, or with another event's quest", async () => {
      const event = await newEvent();
      const other = await newEvent();
      const foreign = await newQuest(other);
      const { assignment } = await newOperator(event);
      const body = { abilities: ["scan_quests"], canPlay: false, questIds: [] };
      expect(
        (
          await dashboard("PUT", `/events/${event}/operators/${assignment}`, body, editorCookie)
        ).json(),
      ).toMatchObject({
        code: "owner_only",
      });
      expect(
        (await dashboard("PUT", `/events/${event}/operators/${randomUUID()}`, body)).statusCode,
      ).toBe(404);
      expect(
        (
          await dashboard("PUT", `/events/${event}/operators/${assignment}`, {
            ...body,
            questIds: [foreign],
          })
        ).json(),
      ).toMatchObject({ code: "invalid_operator", details: { field: "questIds" } });
      expect(
        (await dashboard("PUT", `/events/${event}/operators/${assignment}`, body)).json(),
      ).toEqual({
        operator: { id: assignment, ...body },
      });
      expect(
        (
          await dashboard(
            "DELETE",
            `/events/${event}/operators/${assignment}`,
            undefined,
            editorCookie,
          )
        ).json(),
      ).toMatchObject({ code: "owner_only" });
    });
  });

  describe("what the list and the log keep", () => {
    it("emails only email invites, ties each to its request, and names an expired or unclaimed invite as such", async () => {
      const event = await newEvent();
      const before = test.mail.sent.length;
      const personal = await newInvite(event);
      expect(test.mail.sent.length).toBe(before);
      const [audit] = await owner<{ request_id: string | null }>(
        "SELECT request_id FROM audit_log WHERE action = 'operator.invite' AND event_id = $1",
        [event],
      );
      expect(audit?.request_id).toMatch(/^[0-9a-f-]{36}$/);
      const old = await newInvite(event);
      await owner(
        "UPDATE operator_invite SET expires_at = now() - interval '1 second' WHERE id = $1",
        [old.id],
      );
      const invites = (await dashboard("GET", `/events/${event}/operators`)).json<{
        invites: Row[];
      }>().invites;
      expect(invites.find((row) => row["id"] === personal.id)).toMatchObject({
        status: "open",
        claimedBy: null,
      });
      expect(invites.find((row) => row["id"] === old.id)).toMatchObject({ status: "expired" });
      expect(invites.find((row) => row["id"] === old.id)).not.toHaveProperty("url");
    });

    it("logs why an email invite could not be sent, then cancels it", async () => {
      const event = await newEvent();
      test.mail.failing = true;
      try {
        const sent = await dashboard("POST", `/events/${event}/operators/invites`, {
          kind: "email",
          email: "late@najd.sa",
        });
        expect(sent.statusCode).toBe(503);
      } finally {
        test.mail.failing = false;
      }
      expect(logged("operator.invite_not_sent")).toMatchObject([{ reason: "EmailSendError" }]);
      expect(lines.join("\n")).not.toContain("late@najd.sa");
    });

    it("names the operator's events and stations in both languages", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const operator = await newOperator(event);
      expect((await app("GET", "/v1/me/operator-events", operator.token)).json()).toMatchObject({
        events: [{ eventId: event, name: { ar: null, en: "Refusal Fest" } }],
      });
      expect(
        (await app("GET", `/v1/operator/events/${event}/stations`, operator.token)).json(),
      ).toEqual({
        stations: [
          {
            questId: quest,
            title: { ar: null, en: "Gate" },
            points: 25,
            visible: true,
            doneToday: 0,
            doneTotal: 0,
            type: "scan_qr",
          },
        ],
      });
    });
  });

  describe("claiming", () => {
    it("answers expired, wrong email and already an operator, on preview and claim alike", async () => {
      const event = await newEvent();
      const operator = await newOperator(event);
      const second = await newInvite(event);
      for (const path of ["/v1/operator-invites/preview", "/v1/operator-invites/claim"]) {
        expect(
          (await app("POST", path, operator.token, { token: second.token })).json(),
        ).toMatchObject({
          code: "already_operator",
        });
      }
      const email = await newInvite(event, { kind: "email", email: "lead@najd.sa" });
      const stranger = await newPlayer();
      for (const path of ["/v1/operator-invites/preview", "/v1/operator-invites/claim"]) {
        const answer = await app("POST", path, stranger.token, { token: email.token });
        expect(answer.statusCode).toBe(403);
        expect(answer.json()).toMatchObject({ code: "invite_email_mismatch" });
      }
      await owner(
        "UPDATE event SET status = 'ended', ends_at = now() - interval '1 minute' WHERE id = $1",
        [event],
      );
      expect(
        (
          await app("POST", "/v1/operator-invites/preview", stranger.token, { token: second.token })
        ).json(),
      ).toMatchObject({ code: "invite_expired" });
      expect(
        (
          await app("POST", "/v1/operator-invites/claim", stranger.token, {
            token: inviteCode(INVITE_KEY, randomUUID()),
          })
        ).statusCode,
      ).toBe(404);
    });

    it("lists the operator's events with their times as text", async () => {
      const event = await newEvent();
      const operator = await newOperator(event);
      const [listed] = (await app("GET", "/v1/me/operator-events", operator.token)).json<{
        events: Row[];
      }>().events;
      expect(listed?.["startsAt"]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(listed?.["endsAt"]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  describe("playing and My QR", () => {
    it("refuses to enroll an allowed operator once the event has ended", async () => {
      const event = await newEvent();
      const operator = await newOperator(event);
      await dashboard("PUT", `/events/${event}/operators/${operator.assignment}`, {
        abilities: ["scan_quests"],
        canPlay: true,
        questIds: [],
      });
      await owner(
        "UPDATE event SET status = 'ended', ends_at = now() - interval '1 minute' WHERE id = $1",
        [event],
      );
      const answer = await app("POST", `/v1/events/${event}/operator/play`, operator.token, {
        cardVersion: joinCard().version,
      });
      expect(answer.json()).toMatchObject({ code: "event_closed" });
    });

    it("refuses a sixth code reset in a day", async () => {
      const player = await newPlayer();
      for (let round = 0; round < 5; round += 1) {
        expect((await app("POST", "/v1/me/qr/reset", player.token)).statusCode).toBe(200);
      }
      const sixth = await app("POST", "/v1/me/qr/reset", player.token);
      expect(sixth.statusCode).toBe(429);
      expect(sixth.json()).toMatchObject({ code: "too_many_resets" });
    });
  });

  describe("the station's red reasons", () => {
    it("names each reason, with the detail when there is one, and logs it without the code", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const printedOnly = await newQuest(event, { verification: ["quest_qr"] });
      const hidden = await newQuest(event, { visible: false });
      const banned = await newPlayer(event, "banned");
      const player = await newPlayer(event);
      const scanner = await newOperator(event);
      const scan = (who: string, questId: string, scanned: string) =>
        app("POST", "/v1/operator/scan", who, { questId, code: myCode(MY_KEY, scanned, 1) }).then(
          (answer) => answer.json<Row>(),
        );

      expect(await scan(scanner.token, quest, banned.id)).toMatchObject({
        result: "refused",
        reason: "enrollment_inactive",
        detail: "banned",
        player: { avatar: "falcon" },
      });
      expect(await scan(scanner.token, hidden, player.id)).toMatchObject({
        reason: "quest_not_open",
        detail: "hidden",
      });
      const wrong = await scan(scanner.token, printedOnly, player.id);
      expect(wrong).toEqual({
        result: "refused",
        reason: "wrong_method",
        player: expect.any(Object),
      });
      expect(logged("operator.scan_refused").map((line) => line["reason"])).toEqual([
        "enrollment_inactive",
        "quest_not_open",
        "wrong_method",
      ]);
      expect(lines.join("\n")).not.toContain(myCode(MY_KEY, player.id, 1));

      const limited = await newOperator(event, "prize_desk");
      expect(await scan(limited.token, quest, player.id)).toMatchObject({ reason: "ability_off" });
      await dashboard("PUT", `/events/${event}/operators/${scanner.assignment}`, {
        abilities: ["scan_quests"],
        canPlay: false,
        questIds: [printedOnly],
      });
      expect(await scan(scanner.token, quest, player.id)).toMatchObject({
        reason: "outside_station",
      });

      lines = [];
      await app("POST", "/v1/operator/scan", scanner.token, { questId: quest, code: "nope" });
      expect(logged("operator.scan_refused")).toMatchObject([
        { reason: "invalid_code", problem: "not_questify" },
      ]);
    });

    it("logs a completed scan and refuses a key reused for another scan", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const operator = await newOperator(event);
      const first = await newPlayer(event);
      const second = await newPlayer(event);
      const key = randomUUID();
      const done = await app(
        "POST",
        "/v1/operator/scan",
        operator.token,
        { questId: quest, code: myCode(MY_KEY, first.id, 1) },
        key,
      );
      expect(done.json()).toMatchObject({ result: "completed" });
      expect(logged("operator.scan_completed")).toMatchObject([
        { questId: quest, replayed: "false" },
      ]);
      const reused = await app(
        "POST",
        "/v1/operator/scan",
        operator.token,
        { questId: quest, code: myCode(MY_KEY, second.id, 1) },
        key,
      );
      expect(reused.statusCode).toBe(422);
    });
  });
});
