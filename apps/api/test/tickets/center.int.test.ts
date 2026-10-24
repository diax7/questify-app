import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loggerOptions } from "#src/app";
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

/** Every field name in a body, at any depth. */
const keysOf = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.flatMap(keysOf)
    : typeof value === "object" && value !== null
      ? Object.entries(value).flatMap(([key, inner]) => [key, ...keysOf(inner)])
      : [];

const answerOf = (response: { statusCode: number; json: () => unknown }) => [
  response.statusCode,
  (response.json() as { code?: string }).code,
];

const DEVICE = { appVersion: "1.4.0", platform: "ios", osVersion: "18.1", model: "iPhone 15 Pro" };

/**
 * The ticket center over HTTP (T-312): Report a player and its lookup cap, app problems and suggestions with no event,
 * the profile's dot, escalation from the dashboard, the console's Tickets (admin only, 404 for anyone else, no-store,
 * 120 calls a minute), the bodies scanned for names and emails, and logs that never hold a note, a username or a model.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("the ticket center over HTTP", () => {
  let db: TestDatabase;
  let test: TestApp;
  let organizer = "";
  let ownerCookie = "";
  let adminCookie = "";
  let counter = 0;

  beforeAll(async () => {
    db = await createTestDatabase();
    test = await startApp(db);
    organizer =
      (
        await db.owner.query<{ id: string }>(
          "INSERT INTO organizer (name, slug) VALUES ('center-org', 'center-org') RETURNING id",
        )
      ).rows[0]?.id ?? "";
    const id = await createStaff(db.owner, { email: "owner@center.test" });
    await db.owner.query(
      "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, 'owner')",
      [organizer, id],
    );
    await createStaff(db.owner, { email: "support@questify.test", admin: true });
    ownerCookie = await signInFully(test, "owner@center.test");
    adminCookie = await signInFully(test, "support@questify.test");
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
       VALUES ($1, $2, 'Center Fest', 'live', now() - interval '1 hour', now() + interval '1 day') RETURNING id`,
      [organizer, `CNTH${counter}`],
    );
    return event?.id ?? "";
  };
  const newPlayer = async (event: string | null) => {
    counter += 1;
    const username = `center_http_${counter}`;
    const [player] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [username],
    );
    const id = player?.id ?? "";
    const token = randomBytes(32).toString("base64url");
    await owner(
      "INSERT INTO player_session (player_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
      [id, createHash("sha256").update(token).digest()],
    );
    if (event !== null) {
      await owner(
        "INSERT INTO enrollment (organizer_id, event_id, player_id) VALUES ($1, $2, $3)",
        [organizer, event, id],
      );
    }
    return { id, token, username };
  };
  const app = (
    method: "GET" | "POST",
    path: string,
    token: string,
    payload?: object,
    target: TestApp = test,
  ) =>
    target.app.inject({
      method,
      url: path,
      headers: { authorization: `Bearer ${token}`, "idempotency-key": randomUUID() },
      ...(payload === undefined ? {} : { payload }),
    });
  const staff = (
    cookie: string,
    method: "GET" | "POST",
    url: string,
    payload?: object,
    target: TestApp = test,
  ) =>
    target.app.inject({
      method,
      url,
      headers: withSession(cookie, { "idempotency-key": randomUUID() }),
      ...(payload === undefined ? {} : { payload }),
    });
  const dashboard = (method: "GET" | "POST", path: string, payload?: object) =>
    staff(ownerCookie, method, `/v1/organizers/${organizer}${path}`, payload);
  const adminCall = (method: "GET" | "POST", path: string, payload?: object) =>
    staff(adminCookie, method, `/v1/admin${path}`, payload);

  it("sends a report by username and answers each refusal; the 11th unknown name in an hour waits", async () => {
    const event = await newEvent();
    const sara = await newPlayer(event);
    const khalid = await newPlayer(event);
    const report = (username: string | undefined, extra: object = {}) =>
      app("POST", `/v1/events/${event}/tickets`, sara.token, {
        kind: "report_player",
        ...(username === undefined ? {} : { reportedUsername: username }),
        text: "He shoved me",
        ...extra,
      });
    const sent = await report(khalid.username.toUpperCase());
    expect(sent.statusCode).toBe(201);
    expect(answerOf(await report(khalid.username))).toEqual([409, "already_reported"]);
    expect(answerOf(await report(sara.username))).toEqual([403, "self_report"]);
    expect(answerOf(await report(undefined))).toEqual([422, "username_required"]);
    expect(answerOf(await report(khalid.username, { questId: randomUUID() }))).toEqual([
      400,
      "invalid_request",
    ]);
    const question = await app("POST", `/v1/events/${event}/tickets`, sara.token, {
      kind: "question",
      reportedUsername: khalid.username,
      text: "Hi",
    });
    expect(answerOf(question)).toEqual([400, "invalid_request"]);
    const prize = await app("POST", `/v1/events/${event}/tickets`, sara.token, {
      kind: "prize",
      text: "My prize is broken",
    });
    expect(prize.statusCode).toBe(201);
    for (let miss = 0; miss < 10; miss += 1) {
      expect(answerOf(await report(`nobody_${miss}`))).toEqual([404, "unknown_player"]);
    }
    const capped = await report("nobody_more");
    expect(answerOf(capped)).toEqual([429, "too_many_lookups"]);
    expect(Number(capped.headers["retry-after"])).toBeGreaterThan(3000);
    const mine = await app("GET", `/v1/events/${event}/tickets/mine`, sara.token);
    expect(mine.json()).toMatchObject({
      tickets: [
        { kind: "prize", reportedUsername: null },
        { kind: "report_player", reportedUsername: khalid.username, withQuestify: false },
      ],
    });
    const theirs = await app("GET", "/v1/me/tickets", khalid.token);
    expect(theirs.json()).toEqual({ tickets: [] });
  });

  it("never lets reports sent at once pass the lookup cap together (CTO code review 1)", async () => {
    const event = await newEvent();
    const sara = await newPlayer(event);
    const answers = await Promise.all(
      Array.from({ length: 14 }, (_, miss) =>
        app("POST", `/v1/events/${event}/tickets`, sara.token, {
          kind: "report_player",
          reportedUsername: `ghost_${miss}`,
          text: "Who is this",
        }),
      ),
    );
    const codes = answers.map((answer) => answer.json<{ code: string }>().code);
    expect(codes.filter((code) => code === "unknown_player")).toHaveLength(10);
    expect(codes.filter((code) => code === "too_many_lookups")).toHaveLength(4);
  });

  it("sends app problems and suggestions with no event, and the profile shows the unread dot", async () => {
    const nobody = await newPlayer(null);
    const send = (payload: object) => app("POST", "/v1/me/tickets", nobody.token, payload);
    const sent = await send({ kind: "app_problem", text: "The map is blank", device: DEVICE });
    expect(sent.statusCode).toBe(201);
    const id = sent.json<{ ticket: { id: string } }>().ticket.id;
    expect(answerOf(await send({ kind: "app_problem", text: "No device" }))).toEqual([
      400,
      "invalid_request",
    ]);
    expect(
      answerOf(
        await send({ kind: "app_problem", text: "x", device: { ...DEVICE, model: "a\u0007" } }),
      ),
    ).toEqual([422, "invalid_device"]);
    expect(answerOf(await send({ kind: "question", text: "x" }))).toEqual([400, "invalid_request"]);
    expect(answerOf(await send({ kind: "suggestion", text: " " }))).toEqual([422, "invalid_text"]);
    expect((await send({ kind: "suggestion", text: "Dark mode", device: DEVICE })).statusCode).toBe(
      201,
    );
    expect((await send({ kind: "suggestion", text: "Badges" })).statusCode).toBe(201);
    expect(answerOf(await send({ kind: "suggestion", text: "More" }))).toEqual([
      409,
      "too_many_open",
    ]);
    const [stored] = await owner<Row>(
      "SELECT platform, device_model FROM ticket WHERE player_id = $1 AND kind = 'suggestion' LIMIT 1",
      [nobody.id],
    );
    expect(stored).toEqual({ platform: null, device_model: null });
    expect((await app("GET", "/v1/me", nobody.token)).json()).toMatchObject({
      help: { unread: 0 },
    });
    const answered = await adminCall("POST", `/tickets/${id}/answer`, { reply: "Fixed in 1.4.1" });
    expect(answered.json()).toEqual({ ticketId: id, outcome: "answered", replayed: false });
    expect((await app("GET", "/v1/me", nobody.token)).json()).toMatchObject({
      help: { unread: 1 },
    });
    const listed = await app("GET", "/v1/me/tickets", nobody.token);
    expect(listed.json()).toMatchObject({
      tickets: expect.arrayContaining([
        expect.objectContaining({
          id,
          event: null,
          answeredBy: "questify",
          reply: "Fixed in 1.4.1",
        }),
      ]),
    });
    expect(JSON.stringify(listed.json())).not.toMatch(/@|iPhone/);
  });

  it("escalates from the dashboard; the console answers; the dashboard shows the Questify team", async () => {
    const event = await newEvent();
    const sara = await newPlayer(event);
    const sent = await app("POST", `/v1/events/${event}/tickets`, sara.token, {
      kind: "question",
      text: "Where do I collect my prize?",
    });
    const id = sent.json<{ ticket: { id: string } }>().ticket.id;
    expect(
      answerOf(await dashboard("POST", `/events/${event}/tickets/${id}/escalate`, { note: " " })),
    ).toEqual([422, "invalid_text"]);
    const escalated = await dashboard("POST", `/events/${event}/tickets/${id}/escalate`, {
      note: "We checked the desk",
    });
    expect(escalated.json()).toEqual({ ticketId: id, queue: "questify", replayed: false });
    expect(
      answerOf(
        await dashboard("POST", `/events/${event}/tickets/${id}/escalate`, { note: "Again" }),
      ),
    ).toEqual([409, "moved"]);
    const stale = await dashboard("POST", `/events/${event}/tickets/${id}/answer`, {});
    expect(answerOf(stale)).toEqual([409, "moved"]);
    expect(stale.json()).toMatchObject({
      message: { ar: "انتقل هذا الطلب. حدّث الصفحة.", en: "This request moved. Refresh the page." },
    });
    const tab = await dashboard("GET", `/events/${event}/tickets?status=with_questify`);
    expect(tab.json()).toMatchObject({
      tickets: [
        {
          id,
          queue: "questify",
          escalation: { note: "We checked the desk", by: "owner@center.test" },
        },
      ],
      counts: { open: 0, withQuestify: 1, closed: 0, waitingByKind: { question: 1 } },
    });
    const mine = await app("GET", "/v1/me/tickets", sara.token);
    expect(mine.json()).toMatchObject({ tickets: [{ id, withQuestify: true }] });
    expect(JSON.stringify(mine.json())).not.toContain("We checked the desk");

    const list = await adminCall("GET", "/tickets?status=open&source=escalated");
    expect(list.statusCode).toBe(200);
    expect(list.headers["cache-control"]).toBe("no-store");
    const row = list.json<{ tickets: Row[] }>().tickets.find((item) => item["id"] === id);
    expect(row).toMatchObject({
      preview: "Where do I collect my prize?",
      event: { eventId: event },
    });
    expect(keysOf(list.json())).not.toContain("avatar");
    const detail = await adminCall("GET", `/tickets/${id}`);
    expect(detail.json()).toMatchObject({
      ticket: {
        id,
        text: "Where do I collect my prize?",
        escalation: { note: "We checked the desk" },
      },
    });
    const answered = await adminCall("POST", `/tickets/${id}/answer`, { reply: "At gate 3" });
    expect(answered.json()).toMatchObject({ outcome: "answered" });
    const closed = await dashboard("GET", `/events/${event}/tickets?status=closed`);
    expect(closed.json()).toMatchObject({
      tickets: [{ id, answeredBy: { kind: "admin", name: null }, reply: "At gate 3" }],
    });
    expect(JSON.stringify(closed.json())).not.toContain("support@questify.test");
    expect((await app("GET", "/v1/me/tickets", sara.token)).json()).toMatchObject({
      tickets: [{ id, answeredBy: "questify", withQuestify: false }],
    });
  });

  it("sends back with a note; a ticket outside the queue is the same 404 as a missing one", async () => {
    const event = await newEvent();
    const sara = await newPlayer(event);
    const make = async (text: string) =>
      (
        await app("POST", `/v1/events/${event}/tickets`, sara.token, { kind: "question", text })
      ).json<{ ticket: { id: string } }>().ticket.id;
    const never = await make("Never escalated");
    const moved = await make("Escalated then back");
    await dashboard("POST", `/events/${event}/tickets/${moved}/escalate`, { note: "Tried" });
    for (const path of [`/tickets/${never}`, "/tickets/999999999"]) {
      expect(answerOf(await adminCall("GET", path))).toEqual([404, "not_found"]);
    }
    expect(answerOf(await adminCall("POST", `/tickets/${never}/return`, { note: "x" }))).toEqual([
      404,
      "not_found",
    ]);
    const back = await adminCall("POST", `/tickets/${moved}/return`, { note: "Ask the venue" });
    expect(back.json()).toEqual({ ticketId: moved, queue: "event", replayed: false });
    expect(answerOf(await adminCall("GET", `/tickets/${moved}`))).toEqual([404, "not_found"]);
    expect(answerOf(await adminCall("POST", `/tickets/${moved}/answer`, {}))).toEqual([
      409,
      "moved",
    ]);
    const open = await dashboard("GET", `/events/${event}/tickets?status=open`);
    expect(open.json()).toMatchObject({
      tickets: expect.arrayContaining([
        expect.objectContaining({
          id: moved,
          returned: { at: expect.any(String), note: "Ask the venue" },
        }),
      ]),
    });
    const direct = await newPlayer(null);
    const idea = (
      await app("POST", "/v1/me/tickets", direct.token, { kind: "suggestion", text: "Idea" })
    ).json<{ ticket: { id: string } }>().ticket.id;
    expect(answerOf(await adminCall("POST", `/tickets/${idea}/return`, { note: "x" }))).toEqual([
      409,
      "not_escalated",
    ]);
  });

  it("answers 404 to any signed-in non-admin, 401 with no staff session, and holds an admin to 120 a minute", async () => {
    const sara = await newPlayer(null);
    const asPlayer = await test.app.inject({
      method: "GET",
      url: "/v1/admin/tickets",
      headers: { authorization: `Bearer ${sara.token}` },
    });
    // The console hook's existing contract (T-210): no staff session is 401, as on every /v1/admin/ route.
    expect(asPlayer.statusCode).toBe(401);
    expect((await test.app.inject({ method: "GET", url: "/v1/admin/tickets" })).statusCode).toBe(
      401,
    );
    expect((await staff(ownerCookie, "GET", "/v1/admin/tickets")).statusCode).toBe(404);
    expect((await staff(ownerCookie, "GET", "/v1/admin/tickets/counts")).statusCode).toBe(404);
    const counts = await adminCall("GET", "/tickets/counts");
    expect(counts.json()).toMatchObject({ counts: { open: expect.any(Number) } });
    const lines: string[] = [];
    const logged = await startApp(db, {
      ...loggerOptions(testConfig()),
      level: "debug",
      stream: { write: (line: string) => void lines.push(line) },
    });
    try {
      await createStaff(db.owner, { email: "busy@questify.test", admin: true });
      const busy = await signInFully(logged, "busy@questify.test");
      let last = 0;
      for (let call = 0; call < 121; call += 1) {
        last = (await staff(busy, "GET", "/v1/admin/tickets/counts", undefined, logged)).statusCode;
      }
      expect(last).toBe(429);
      const text = lines.join("\n");
      expect(text).toContain("console.tickets_throttled");
      expect(text).not.toContain("busy@questify.test");
    } finally {
      await logged.close();
    }
  });

  it("logs the center's events and never a note, a reported username or a device model", async () => {
    const lines: string[] = [];
    const logged = await startApp(db, {
      ...loggerOptions(testConfig()),
      level: "debug",
      stream: { write: (line: string) => void lines.push(line) },
    });
    try {
      const cookie = await signInFully(logged, "owner@center.test");
      const admin = await signInFully(logged, "support@questify.test");
      const event = await newEvent();
      const sara = await newPlayer(event);
      const target = await newPlayer(event);
      const note = `secret note ${randomUUID()}`;
      const back = `secret return ${randomUUID()}`;
      const model = `Secret Phone ${randomUUID().slice(0, 8)}`;
      const report = await app(
        "POST",
        `/v1/events/${event}/tickets`,
        sara.token,
        { kind: "report_player", reportedUsername: target.username, text: "Report" },
        logged,
      );
      const id = report.json<{ ticket: { id: string } }>().ticket.id;
      await app(
        "POST",
        "/v1/me/tickets",
        sara.token,
        { kind: "app_problem", text: "Crash", device: { ...DEVICE, model } },
        logged,
      );
      await staff(
        cookie,
        "POST",
        `/v1/organizers/${organizer}/events/${event}/tickets/${id}/escalate`,
        { note },
        logged,
      );
      await staff(admin, "POST", `/v1/admin/tickets/${id}/return`, { note: back }, logged);
      const text = lines.join("\n");
      for (const name of ["ticket.opened", "ticket.escalated", "ticket.returned"]) {
        expect(text).toContain(name);
      }
      for (const secret of [
        note,
        back,
        model,
        target.username,
        sara.username,
        "support@questify.test",
      ]) {
        expect(text, `log contains ${secret.slice(0, 12)}`).not.toContain(secret);
      }
    } finally {
      await logged.close();
    }
  });
});
