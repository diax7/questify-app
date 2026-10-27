import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withRequestContext, type RequestContext } from "#src/db/context";
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
 * An archived event over HTTP (T-411, FR-751, ADR-341): after the archive step, everything the player keeps still
 * reads (the event list, Home, the recap, the passport, the public profile, the profile, locker and achievements, the
 * points record, results, the shop with My rewards, tickets), and no organizer door moves it back.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("an archived event over HTTP", () => {
  let db: TestDatabase;
  let test: TestApp;
  let organizer = "";
  let staff = "";
  let cookie = "";
  let event = "";
  let player = { id: "", token: "", username: "" };

  const owner = async <T extends Row>(sql: string, values: unknown[] = []) =>
    (await db.owner.query<T>(sql, values)).rows;
  const as = async <T extends Row>(context: RequestContext, sql: string, values: unknown[] = []) =>
    withRequestContext(db.app, context, async () => (await db.app.query<T>(sql, values)).rows);
  const team = (): RequestContext => ({ organizerId: organizer, staffUserId: staff });
  const get = (url: string) =>
    test.app.inject({ method: "GET", url, headers: { authorization: `Bearer ${player.token}` } });

  /** An ended public event with one member who earned 40 points, its results confirmed and revealed, then archived. */
  beforeAll(async () => {
    db = await createTestDatabase();
    test = await startApp(db);
    [{ id: organizer = "" } = { id: "" }] = await owner<{ id: string }>(
      "INSERT INTO organizer (name, slug) VALUES ('archive-org', 'archive-org') RETURNING id",
    );
    staff = await createStaff(db.owner, { email: "owner@archive.test" });
    await owner(
      "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, 'owner')",
      [organizer, staff],
    );
    cookie = await signInFully(test, "owner@archive.test");
    [{ id: event = "" } = { id: "" }] = await owner<{ id: string }>(
      `INSERT INTO event (organizer_id, join_code, name_ar, name_en, status, starts_at, ends_at, desk_location_en)
       VALUES ($1, 'ARCH1', 'مهرجان', 'Archive Fest', 'ended', now() - interval '11 days', now() - interval '10 days',
               'Hall B') RETURNING id`,
      [organizer],
    );
    const token = randomBytes(32).toString("base64url");
    const [made] = await owner<{ id: string; username: string }>(
      "INSERT INTO player (username) VALUES ('archive_player') RETURNING id, username",
    );
    player = { id: made?.id ?? "", token, username: made?.username ?? "" };
    await owner(
      "INSERT INTO player_session (player_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
      [player.id, createHash("sha256").update(token).digest()],
    );
    const [enrolled] = await owner<{ id: string }>(
      `INSERT INTO enrollment (organizer_id, event_id, player_id, joined_via) VALUES ($1, $2, $3, 'code')
       RETURNING id`,
      [organizer, event, player.id],
    );
    const [quest] = await owner<{ id: string }>(
      `INSERT INTO quest (event_id, category_id, type, title_en, points, repeat_cap, visible, type_config)
       SELECT $1, id, 'scan_qr', 'Quest', 40, 1, true, '{}' FROM category WHERE event_id = $1 LIMIT 1 RETURNING id`,
      [event],
    );
    const [done] = await owner<{ id: string }>(
      `INSERT INTO quest_completion (organizer_id, event_id, enrollment_id, quest_id, occurrence, method,
                                     idempotency_key, created_at)
       VALUES ($1, $2, $3, $4, 1, 'qr', $5, now() - interval '10 days 2 hours') RETURNING id`,
      [organizer, event, enrolled?.id, quest?.id, randomUUID()],
    );
    await owner(
      `INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta,
                                 completion_id, quest_id, actor, created_at)
       VALUES ($1, $2, $3, 'quest', 40, 40, $4, $5, 'player', now() - interval '10 days 2 hours')`,
      [organizer, event, enrolled?.id, done?.id, quest?.id],
    );
    const places = await as<{ enrollment_id: string }>(team(), "SELECT * FROM results_places($1)", [
      event,
    ]);
    await as(team(), "SELECT confirm_results($1, $2, $3)", [
      event,
      places.map((place) => place.enrollment_id),
      randomUUID(),
    ]);
    await as(team(), "SELECT reveal_results($1, now() + interval '1 day', $2)", [
      event,
      randomUUID(),
    ]);
    await as({}, "SELECT archive_ended_events()");
  });
  afterAll(async () => {
    await test.close();
    await db.close();
  });

  it("is archived by the step", async () => {
    expect(await owner("SELECT status FROM event WHERE id = $1", [event])).toEqual([
      { status: "archived" },
    ]);
  });

  it("stays in the player's events and Home, with the score and a closed shop", async () => {
    const mine = await get("/v1/me/events");
    expect(mine.statusCode).toBe(200);
    expect(mine.json().events).toEqual([
      expect.objectContaining({ id: event, statusNow: "archived", status: "active", score: 40 }),
    ]);
    const home = await get(`/v1/events/${event}/home`);
    expect(home.statusCode).toBe(200);
    expect(home.json()).toMatchObject({
      event: { id: event, statusNow: "archived" },
      standing: { status: "active", score: 40 },
      shopWindow: { state: "closed" },
      goal: null,
      win: null,
    });
  });

  it("still opens the recap, the passport and the public profile's stamp with the final rank", async () => {
    const recap = await get(`/v1/events/${event}/recap`);
    expect(recap.statusCode).toBe(200);
    expect(recap.json()).toMatchObject({ rank: { state: "final", value: 1 }, questsDone: 1 });
    const history = await get("/v1/me/event-history");
    expect(history.statusCode).toBe(200);
    expect(JSON.stringify(history.json())).toContain(event);
    const profile = await get(`/v1/players/${player.username}`);
    expect(profile.statusCode).toBe(200);
    expect(profile.json().passport).toEqual([expect.objectContaining({ rank: 1 })]);
  });

  it("still reads the profile, locker, achievements, points record, results, shop and tickets", async () => {
    for (const url of [
      "/v1/me",
      "/v1/me/locker",
      "/v1/me/achievements",
      "/v1/me/tickets",
      `/v1/events/${event}/activity`,
      `/v1/events/${event}/results`,
      `/v1/events/${event}/shop`,
      `/v1/events/${event}/tickets/mine`,
    ]) {
      expect((await get(url)).statusCode, url).toBe(200);
    }
    expect((await get(`/v1/events/${event}/shop`)).json()).toMatchObject({
      shop: { state: "closed" },
    });
  });

  it("refuses the owner moving it back: no status field, no ending again, no delete", async () => {
    const path = `/v1/organizers/${organizer}/events/${event}`;
    const patch = await test.app.inject({
      method: "PATCH",
      url: path,
      headers: withSession(cookie),
      payload: { status: "ended" },
    });
    expect(patch.statusCode).toBe(400);
    const end = await test.app.inject({
      method: "POST",
      url: `${path}/end`,
      headers: withSession(cookie),
      payload: { confirm: true },
    });
    expect(end.statusCode).toBe(409);
    const remove = await test.app.inject({
      method: "DELETE",
      url: path,
      headers: withSession(cookie),
    });
    expect(remove.statusCode).toBeGreaterThanOrEqual(400);
    expect(await owner("SELECT status FROM event WHERE id = $1", [event])).toEqual([
      { status: "archived" },
    ]);
  });
});
