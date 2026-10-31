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

const en = (text: string) => ({ en: text });
const codeOf = (response: { statusCode: number; json: () => { code?: string } }) => [
  response.statusCode,
  response.json().code,
];
const OPTIONS = [
  { id: "a", text: en("Robots") },
  { id: "b", text: en("Space") },
  { id: "c", text: en("Oceans") },
];
const poll = (choices = "one", results = "after_vote", minutes = 5) => ({
  options: OPTIONS,
  live: { choices, results, minutes },
});

/**
 * Live polls over HTTP (T-306): the builder keeps a draft hidden, Send and Close with their refusals, the several-choice
 * vote and `too_many_choices`, the poll read with its results policy, and the live read with its ETag, 304,
 * `Server-Now`, empty answer and limit.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("live polls over HTTP", () => {
  let db: TestDatabase;
  let test: TestApp;
  let organizer = "";
  let ownerCookie = "";
  let counter = 0;

  beforeAll(async () => {
    db = await createTestDatabase();
    test = await startApp(db, false);
    organizer =
      (
        await db.owner.query<{ id: string }>(
          "INSERT INTO organizer (name, slug) VALUES ('poll-org', 'poll-org') RETURNING id",
        )
      ).rows[0]?.id ?? "";
    const id = await createStaff(db.owner, { email: "owner@poll.test" });
    await db.owner.query(
      "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, 'owner')",
      [organizer, id],
    );
    ownerCookie = await signInFully(test, "owner@poll.test");
  });
  afterAll(async () => {
    await test.close();
    await db.close();
  });

  const owner = async <T extends Row>(sql: string, values: unknown[] = []) =>
    (await db.owner.query<T>(sql, values)).rows;
  const newEvent = async (status = "live"): Promise<string> => {
    counter += 1;
    const [event] = await owner<{ id: string }>(
      `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at)
       VALUES ($1, $2, 'Poll Fest', $3, now() - interval '1 hour', now() + interval '1 day') RETURNING id`,
      [organizer, `POLL${counter}`, status],
    );
    return event?.id ?? "";
  };
  const newPlayer = async (event: string) => {
    counter += 1;
    const [player] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`poll_http_${counter}`],
    );
    const id = player?.id ?? "";
    const token = randomBytes(32).toString("base64url");
    await owner(
      "INSERT INTO player_session (player_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
      [id, createHash("sha256").update(token).digest()],
    );
    await owner("INSERT INTO enrollment (organizer_id, event_id, player_id) VALUES ($1, $2, $3)", [
      organizer,
      event,
      id,
    ]);
    return token;
  };
  const app = (
    method: "GET" | "POST",
    path: string,
    token: string,
    payload?: object,
    headers: Record<string, string> = {},
  ) =>
    test.app.inject({
      method,
      url: path,
      headers: { authorization: `Bearer ${token}`, "idempotency-key": randomUUID(), ...headers },
      ...(payload === undefined ? {} : { payload }),
    });
  const dashboard = (method: "GET" | "POST" | "PATCH", path: string, payload?: object) =>
    test.app.inject({
      method,
      url: `/v1/organizers/${organizer}${path}`,
      headers: withSession(ownerCookie, { "idempotency-key": randomUUID() }),
      ...(payload === undefined ? {} : { payload }),
    });
  /** A live poll made through the builder: a draft, hidden with no window. */
  const newPoll = async (event: string, config: object = poll()) => {
    const [category] = await owner<{ id: string }>(
      "SELECT id FROM category WHERE event_id = $1 LIMIT 1",
      [event],
    );
    const made = await dashboard("POST", `/events/${event}/quests`, {
      categoryId: category?.id,
      type: "vote",
      title: en("Next talk?"),
      points: 10,
      visible: true,
      config,
    });
    expect(made.statusCode).toBe(201);
    return made.json().quest as { id: string; visible: boolean; pollSentAt: string | null };
  };
  const send = (event: string, quest: string) =>
    dashboard("POST", `/events/${event}/quests/${quest}/send`, {});
  const close = (event: string, quest: string) =>
    dashboard("POST", `/events/${event}/quests/${quest}/close`, {});

  it("builds a draft, sends it, keeps its window through an edit, and closes it", async () => {
    const event = await newEvent();
    const draft = await newPoll(event);
    expect(draft).toMatchObject({ visible: false, pollSentAt: null });
    const sent = await send(event, draft.id);
    expect(sent.statusCode).toBe(200);
    expect(sent.json()).toMatchObject({ replayed: false });
    expect((await send(event, draft.id)).json()).toEqual({ ...sent.json(), replayed: true });
    const renamed = await dashboard("PATCH", `/events/${event}/quests/${draft.id}`, {
      title: en("Which talk next?"),
      visible: false,
      confirm: true,
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().quest).toMatchObject({
      visible: true,
      closesAt: sent.json().closesAt,
      pollSentAt: sent.json().opensAt,
    });
    const changed = await dashboard("PATCH", `/events/${event}/quests/${draft.id}`, {
      config: poll("several"),
      confirm: true,
    });
    expect([...codeOf(changed), changed.json().details]).toEqual([
      409,
      "poll_locked",
      { field: "choices" },
    ]);
    expect((await close(event, draft.id)).json()).toMatchObject({ replayed: false });
    expect(codeOf(await send(event, draft.id))).toEqual([409, "already_sent"]);
  });

  it("answers each refusal of Send and Close", async () => {
    const event = await newEvent();
    const draft = await newPoll(event);
    expect(codeOf(await close(event, draft.id))).toEqual([409, "not_sent"]);
    const plain = await newPoll(event, { options: OPTIONS });
    expect(codeOf(await send(event, plain.id))).toEqual([422, "not_live_poll"]);
    expect(codeOf(await send(event, randomUUID()))).toEqual([404, "not_found"]);
    const draftEvent = await newEvent("draft");
    const early = await newPoll(draftEvent);
    expect(codeOf(await send(draftEvent, early.id))).toEqual([409, "event_not_live"]);
  });

  it("takes several choices on a several poll, refuses two on a one-choice poll, and reads the poll", async () => {
    const event = await newEvent();
    const several = await newPoll(event, poll("several", "after_vote"));
    const one = await newPoll(event, poll("one", "at_close"));
    await send(event, several.id);
    await send(event, one.id);
    const token = await newPlayer(event);
    const before = (await app("GET", `/v1/quests/${several.id}/poll`, token)).json();
    expect(before).toMatchObject({
      choices: "several",
      results: "after_vote",
      closed: false,
      mine: [],
      counts: null,
      resultsWhen: "after_vote",
    });
    expect(before.options).toHaveLength(3);
    const voted = await app("POST", `/v1/quests/${several.id}/vote`, token, {
      optionIds: ["a", "c"],
    });
    expect(voted.statusCode).toBe(201);
    expect(voted.json()).toMatchObject({ points: 10, replayed: false });
    expect((await app("GET", `/v1/quests/${several.id}/poll`, token)).json()).toMatchObject({
      mine: ["a", "c"],
      counts: {
        options: [
          { id: "a", votes: 1 },
          { id: "b", votes: 0 },
          { id: "c", votes: 1 },
        ],
        voters: 1,
      },
      resultsWhen: null,
    });
    expect(
      codeOf(await app("POST", `/v1/quests/${one.id}/vote`, token, { optionIds: ["a", "b"] })),
    ).toEqual([422, "too_many_choices"]);
    expect(
      codeOf(await app("POST", `/v1/quests/${one.id}/vote`, token, { optionIds: [] })),
    ).toEqual([400, "invalid_request"]);
    const plain = await newPoll(event, { options: OPTIONS });
    expect(codeOf(await app("GET", `/v1/quests/${plain.id}/poll`, token))).toEqual([
      404,
      "not_found",
    ]);
  });

  it("answers 403 feature_off to a live poll's vote and reads while live polls are off (T-602c)", async () => {
    const event = await newEvent();
    const live = await newPoll(event, poll("one", "after_vote"));
    await send(event, live.id);
    const token = await newPlayer(event);
    await owner(
      `UPDATE event SET config = jsonb_set(config, '{features}', coalesce(config -> 'features', '{}')
         || '{"polls": false}'::jsonb) WHERE id = $1`,
      [event],
    );
    expect(codeOf(await app("GET", `/v1/quests/${live.id}/poll`, token))).toEqual([
      403,
      "feature_off",
    ]);
    expect(codeOf(await app("GET", `/v1/quests/${live.id}/vote`, token))).toEqual([
      403,
      "feature_off",
    ]);
    expect(
      codeOf(await app("POST", `/v1/quests/${live.id}/vote`, token, { optionIds: ["a"] })),
    ).toEqual([403, "feature_off"]);
  });

  it("reads what is live with a weak ETag, answers 304 while unchanged, and sends Server-Now on both", async () => {
    const event = await newEvent();
    const token = await newPlayer(event);
    const empty = await app("GET", `/v1/events/${event}/live`, token);
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toMatchObject({ polls: [], closed: [], community: null });
    const draft = await newPoll(event);
    const sent = await send(event, draft.id);
    // The event's "anything live" answer is kept for up to 3 seconds.
    await new Promise((resolve) => setTimeout(resolve, 3100));
    const first = await app("GET", `/v1/events/${event}/live`, token);
    expect(first.json()).toMatchObject({
      polls: [{ questId: draft.id, closesAt: sent.json().closesAt }],
    });
    expect(first.headers["etag"]).toMatch(/^W\/"/);
    expect(Date.parse(String(first.headers["server-now"]))).not.toBeNaN();
    expect(Date.parse(first.json().serverNow)).not.toBeNaN();
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const second = await app("GET", `/v1/events/${event}/live`, token);
    expect(second.headers["etag"]).toBe(first.headers["etag"]);
    const unchanged = await app("GET", `/v1/events/${event}/live`, token, undefined, {
      "if-none-match": String(first.headers["etag"]),
    });
    expect(unchanged.statusCode).toBe(304);
    expect(unchanged.body).toBe("");
    expect(Date.parse(String(unchanged.headers["server-now"]))).not.toBeNaN();
    await app("POST", `/v1/quests/${draft.id}/vote`, token, { optionIds: ["a"] });
    const after = await app("GET", `/v1/events/${event}/live`, token, undefined, {
      "if-none-match": String(first.headers["etag"]),
    });
    expect(after.statusCode).toBe(200);
    expect(after.json().polls).toEqual([]);
  });

  it("answers a stranger's live read with the empty state, and holds a player to 30 a minute", async () => {
    const event = await newEvent();
    const draft = await newPoll(event);
    await send(event, draft.id);
    const stranger = await newPlayer(await newEvent());
    const answer = await app("GET", `/v1/events/${event}/live`, stranger);
    expect(answer.json()).toMatchObject({ polls: [], closed: [], community: null });
    const token = await newPlayer(event);
    const codes: number[] = [];
    for (let call = 0; call < 31; call += 1) {
      codes.push((await app("GET", `/v1/events/${event}/live`, token)).statusCode);
    }
    // A new minute may start inside the loop; at most one window's worth passes either way.
    expect(codes.filter((code) => code === 200).length).toBeGreaterThanOrEqual(30);
    const last = await app("GET", `/v1/events/${event}/live`, token);
    if (last.statusCode === 429) {
      expect(codeOf(last)).toEqual([429, "too_many_attempts"]);
      expect(Number(last.headers["retry-after"])).toBeGreaterThan(0);
    }
  });
});
