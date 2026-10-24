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

/**
 * The help desk over HTTP (T-310): sending with its refusals and Retry-After, the player's own lists with no word of
 * who answered, the seen marks and Home's count, the operator's inbox, ticket and answer, the dashboard's page and
 * answer, the event switch, and logs that never hold the text or the reply.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("the help desk over HTTP", () => {
  let db: TestDatabase;
  let test: TestApp;
  let organizer = "";
  let ownerCookie = "";
  let counter = 0;

  beforeAll(async () => {
    db = await createTestDatabase();
    test = await startApp(db);
    organizer =
      (
        await db.owner.query<{ id: string }>(
          "INSERT INTO organizer (name, slug) VALUES ('help-org', 'help-org') RETURNING id",
        )
      ).rows[0]?.id ?? "";
    const id = await createStaff(db.owner, { email: "owner@help.test" });
    await db.owner.query(
      "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, 'owner')",
      [organizer, id],
    );
    ownerCookie = await signInFully(test, "owner@help.test");
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
       VALUES ($1, $2, 'Help Fest', 'live', now() - interval '1 hour', now() + interval '1 day') RETURNING id`,
      [organizer, `HLPH${counter}`],
    );
    return event?.id ?? "";
  };
  const newPlayer = async (event: string | null) => {
    counter += 1;
    const [player] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`help_http_${counter}`],
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
    return { id, token };
  };
  const newOperator = async (event: string, abilities = ["review", "help_desk"]) => {
    const made = await newPlayer(null);
    await owner(
      "INSERT INTO staff_assignment (organizer_id, event_id, player_id, abilities) VALUES ($1, $2, $3, $4)",
      [organizer, event, made.id, abilities],
    );
    return made;
  };
  const app = (
    method: "GET" | "POST",
    path: string,
    token: string,
    payload?: object,
    key: string = randomUUID(),
    target: TestApp = test,
  ) =>
    target.app.inject({
      method,
      url: path,
      headers: { authorization: `Bearer ${token}`, "idempotency-key": key },
      ...(payload === undefined ? {} : { payload }),
    });
  const dashboard = (
    method: "GET" | "POST" | "PUT",
    path: string,
    payload?: object,
    key = randomUUID(),
  ) =>
    test.app.inject({
      method,
      url: `/v1/organizers/${organizer}${path}`,
      headers: withSession(ownerCookie, { "idempotency-key": key }),
      ...(payload === undefined ? {} : { payload }),
    });
  const send = (token: string, event: string, payload: object, key: string = randomUUID()) =>
    app("POST", `/v1/events/${event}/tickets`, token, payload, key);

  it("sends a question, replays it by key, and lists it as the sender's own", async () => {
    const event = await newEvent();
    const sara = await newPlayer(event);
    const key = randomUUID();
    const sent = await send(sara.token, event, { kind: "question", text: " Where? " }, key);
    expect(sent.statusCode).toBe(201);
    const ticket = sent.json<{ ticket: { id: string; status: string } }>().ticket;
    expect(ticket).toMatchObject({ status: "open", createdAt: expect.any(String) });
    // The idempotency convention answers a retry with the first response; the database replays it too (test/db).
    const again = await send(sara.token, event, { kind: "question", text: " Where? " }, key);
    expect(again.statusCode).toBe(201);
    expect(again.json()).toEqual(sent.json());
    const mine = await app("GET", `/v1/events/${event}/tickets/mine`, sara.token);
    expect(mine.json()).toEqual({
      tickets: [
        {
          id: ticket.id,
          kind: "question",
          quest: null,
          text: "Where?",
          status: "open",
          outcome: null,
          reply: null,
          closedAt: null,
          createdAt: expect.any(String),
          unread: false,
        },
      ],
      open: 1,
      limit: { open: 3 },
    });
  });

  it("answers each sending refusal, with Retry-After on the daily cap", async () => {
    const event = await newEvent();
    const sara = await newPlayer(event);
    const stranger = await newPlayer(null);
    const refused = async (token: string, payload: object) => {
      const response = await send(token, event, payload);
      return [response.statusCode, response.json<{ code: string }>().code];
    };
    expect(await refused(stranger.token, { kind: "question", text: "Hi" })).toEqual([
      403,
      "not_member",
    ]);
    expect(await refused(sara.token, { kind: "question", text: "  " })).toEqual([
      422,
      "invalid_text",
    ]);
    expect(await refused(sara.token, { kind: "praise", text: "Hi" })).toEqual([
      400,
      "invalid_request",
    ]);
    expect(
      await refused(sara.token, { kind: "problem", questId: randomUUID(), text: "No QR" }),
    ).toEqual([404, "unknown_quest"]);
    const [enrollment] = await owner<{ id: string }>(
      "SELECT id FROM enrollment WHERE player_id = $1",
      [sara.id],
    );
    await owner(
      `INSERT INTO ticket (player_id, organizer_id, event_id, enrollment_id, kind, body, idempotency_key)
       SELECT $1, $2, $3, $4, 'question', 'old', 'seed' || g FROM generate_series(1, 3) g`,
      [sara.id, organizer, event, enrollment?.id],
    );
    expect(await refused(sara.token, { kind: "question", text: "Hi" })).toEqual([
      409,
      "too_many_open",
    ]);
    await owner(
      `UPDATE ticket SET status = 'closed', outcome = 'solved', answered_by_operator = player_id,
                         answer_key = idempotency_key, closed_at = now() WHERE player_id = $1`,
      [sara.id],
    );
    await owner(
      `INSERT INTO ticket (player_id, organizer_id, event_id, enrollment_id, kind, body, status, outcome,
                           answered_by_operator, answer_key, closed_at, idempotency_key)
       SELECT $1, $2, $3, $4, 'question', 'old', 'closed', 'solved', $1, 'more' || g, now(), 'more' || g
       FROM generate_series(1, 7) g`,
      [sara.id, organizer, event, enrollment?.id],
    );
    const capped = await send(sara.token, event, { kind: "question", text: "Hi" });
    expect(capped.statusCode).toBe(429);
    expect(Number(capped.headers["retry-after"])).toBeGreaterThan(80_000);
  });

  it("refuses sending with the help desk switched off, and keeps the requests readable", async () => {
    const event = await newEvent();
    const sara = await newPlayer(event);
    const sent = await send(sara.token, event, { kind: "question", text: "Hi" });
    expect(sent.statusCode).toBe(201);
    const off = await dashboard("PUT", `/events/${event}/help-desk`, { enabled: false });
    expect(off.json()).toEqual({ helpDesk: false });
    const shown = await dashboard("GET", `/events/${event}`);
    expect(shown.json()).toMatchObject({ event: { helpDesk: false } });
    const refused = await send(sara.token, event, { kind: "question", text: "Again" });
    expect([refused.statusCode, refused.json().code]).toEqual([403, "feature_off"]);
    const mine = await app("GET", `/v1/events/${event}/tickets/mine`, sara.token);
    expect(mine.json()).toMatchObject({ open: 1 });
  });

  it("closes the loop: operator inbox, ticket and answer; the player's lists, seen marks and Home", async () => {
    const event = await newEvent();
    const sara = await newPlayer(event);
    const op = await newOperator(event);
    const sent = await send(sara.token, event, { kind: "problem", text: "The QR is missing" });
    const id = sent.json<{ ticket: { id: string } }>().ticket.id;
    const inbox = await app("GET", `/v1/operator/events/${event}/inbox`, op.token);
    expect(inbox.json()).toEqual({
      items: [
        {
          kind: "ticket",
          id,
          createdAt: expect.any(String),
          questTitle: null,
          username: expect.stringMatching(/^help_http_/),
          avatar: expect.any(String),
          preview: "The QR is missing",
          marked: false,
          ticketKind: "problem",
        },
      ],
      nextCursor: null,
      abilities: { review: true, helpDesk: true },
    });
    const count = await app("GET", `/v1/operator/events/${event}/inbox/count`, op.token);
    expect(count.json()).toEqual({ submissions: 0, tickets: 1, total: 1 });
    const one = await app("GET", `/v1/operator/events/${event}/tickets/${id}`, op.token);
    expect(one.json()).toMatchObject({ ticket: { id, status: "open", text: "The QR is missing" } });
    const key = randomUUID();
    const answer = (token: string, payload: object, answerKey = randomUUID()) =>
      app("POST", `/v1/operator/events/${event}/tickets/${id}/answer`, token, payload, answerKey);
    const answered = await answer(op.token, { reply: "Back in place" }, key);
    expect(answered.json()).toEqual({ ticketId: id, outcome: "answered", replayed: false });
    expect((await answer(op.token, { reply: "Back in place" }, key)).json()).toEqual(
      answered.json(),
    );
    const second = await newOperator(event);
    const late = await answer(second.token, {});
    expect([late.statusCode, late.json().code]).toEqual([409, "already_closed"]);

    const home = await app("GET", `/v1/events/${event}/home`, sara.token);
    expect(home.json()).toMatchObject({ help: { unread: 1 } });
    const everywhere = await app("GET", "/v1/me/tickets", sara.token);
    expect(everywhere.json()).toMatchObject({
      tickets: [{ id, event: { id: event, name: { en: "Help Fest" } }, reply: "Back in place" }],
    });
    const mine = await app("GET", `/v1/events/${event}/tickets/mine`, sara.token);
    for (const body of [everywhere.json(), mine.json()]) {
      expect(
        keysOf(body).filter((field) => /answer|user|staff|email|operator/i.test(field)),
      ).toEqual([]);
    }
    const seen = await app("POST", "/v1/me/tickets/seen", sara.token, { ids: [id] });
    expect(seen.statusCode).toBe(204);
    expect((await app("GET", `/v1/events/${event}/home`, sara.token)).json()).toMatchObject({
      help: { unread: 0 },
    });
    const eventSeen = await app("POST", `/v1/events/${event}/tickets/seen`, sara.token, {
      ids: [id],
    });
    expect(eventSeen.statusCode).toBe(204);
  });

  it("refuses operators by ability, and a forged inbox cursor", async () => {
    const event = await newEvent();
    const sara = await newPlayer(event);
    const sent = await send(sara.token, event, { kind: "question", text: "Hi" });
    const id = sent.json<{ ticket: { id: string } }>().ticket.id;
    const awarder = await newOperator(event, ["award"]);
    const reviewer = await newOperator(event, ["review"]);
    const codeOf = async (token: string, path: string) =>
      (await app("GET", path, token)).json<{ code: string }>().code;
    expect(await codeOf(awarder.token, `/v1/operator/events/${event}/inbox`)).toBe("ability_off");
    expect(await codeOf(sara.token, `/v1/operator/events/${event}/inbox/count`)).toBe(
      "not_operator",
    );
    expect(await codeOf(reviewer.token, `/v1/operator/events/${event}/tickets/${id}`)).toBe(
      "ability_off",
    );
    const reviewerInbox = await app("GET", `/v1/operator/events/${event}/inbox`, reviewer.token);
    expect(reviewerInbox.json()).toMatchObject({
      items: [],
      abilities: { review: true, helpDesk: false },
    });
    const forged = await app(
      "GET",
      `/v1/operator/events/${event}/inbox?cursor=${Buffer.from('{"p":"1"}').toString("base64url")}`,
      reviewer.token,
    );
    expect(forged.statusCode).toBe(400);
  });

  it("pages the dashboard's tickets and answers from the dashboard", async () => {
    const event = await newEvent();
    const sara = await newPlayer(event);
    const ids: string[] = [];
    for (const text of ["One", "Two", "Three"]) {
      const sent = await send(sara.token, event, { kind: "question", text });
      ids.push(sent.json<{ ticket: { id: string } }>().ticket.id);
    }
    const first = await dashboard("GET", `/events/${event}/tickets?limit=2`);
    expect(first.json()).toMatchObject({
      tickets: [{ id: ids[0], text: "One", username: expect.any(String) }, { id: ids[1] }],
      nextCursor: ids[1],
      counts: { open: 3, closed: 0 },
    });
    const rest = await dashboard("GET", `/events/${event}/tickets?limit=2&cursor=${ids[1]}`);
    expect(rest.json()).toMatchObject({ tickets: [{ id: ids[2] }], nextCursor: null });
    const answered = await dashboard("POST", `/events/${event}/tickets/${ids[0]}/answer`, {
      reply: "Yes",
    });
    expect(answered.json()).toEqual({ ticketId: ids[0], outcome: "answered", replayed: false });
    const solved = await dashboard("POST", `/events/${event}/tickets/${ids[1]}/answer`, {});
    expect(solved.json()).toMatchObject({ outcome: "solved" });
    const closed = await dashboard("GET", `/events/${event}/tickets?status=closed`);
    expect(closed.json()).toMatchObject({
      tickets: [
        { id: ids[1], outcome: "solved", answeredBy: { kind: "staff", name: "owner@help.test" } },
        { id: ids[0], outcome: "answered", reply: "Yes" },
      ],
      counts: { open: 1, closed: 2 },
    });
    const filtered = await dashboard("GET", `/events/${event}/tickets?kind=problem`);
    expect(filtered.json()).toMatchObject({ tickets: [] });
    const unknown = await dashboard("POST", `/events/${event}/tickets/999999/answer`, {});
    expect(unknown.statusCode).toBe(404);
    const elsewhere = await dashboard("GET", `/events/${randomUUID()}/tickets`);
    expect(elsewhere.statusCode).toBe(404);
  });

  it("logs the ticket's events and never its text or reply", async () => {
    const lines: string[] = [];
    const logged = await startApp(db, {
      ...loggerOptions(testConfig()),
      level: "debug",
      stream: { write: (line: string) => void lines.push(line) },
    });
    try {
      const event = await newEvent();
      const sara = await newPlayer(event);
      const op = await newOperator(event);
      const body = `secret question ${randomUUID()}`;
      const said = `secret reply ${randomUUID()}`;
      const sent = await app(
        "POST",
        `/v1/events/${event}/tickets`,
        sara.token,
        { kind: "question", text: body },
        randomUUID(),
        logged,
      );
      const id = sent.json<{ ticket: { id: string } }>().ticket.id;
      await app(
        "POST",
        `/v1/operator/events/${event}/tickets/${id}/answer`,
        op.token,
        { reply: said },
        randomUUID(),
        logged,
      );
      await app(
        "POST",
        `/v1/events/${event}/tickets`,
        sara.token,
        { kind: "question", text: "x".repeat(1001) },
        randomUUID(),
        logged,
      );
      const text = lines.join("\n");
      expect(text).toContain("ticket.opened");
      expect(text).toContain("ticket.answered");
      expect(text).toContain("ticket.refused");
      for (const secret of [body, said, sara.id, "help_http_"]) {
        expect(text, `log contains ${secret.slice(0, 12)}`).not.toContain(secret);
      }
    } finally {
      await logged.close();
    }
  });
});
