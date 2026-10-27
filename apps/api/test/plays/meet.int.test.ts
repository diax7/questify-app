import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryIdempotencyStore } from "#src/idempotency-store";
import type { RankingStore } from "#src/ranking/store";
import { createSettingsService, type SettingsService } from "#src/settings/service";
import {
  createStaff,
  signInFully,
  startApp,
  withSession,
  type TestApp,
} from "#test/support/auth-app";
import { TEST_DATABASE_URL, createTestDatabase, type TestDatabase } from "#test/support/test-db";

type Row = Record<string, unknown>;
type Upsert = Readonly<{ event: string; enrollment: string; score: bigint }>;
type Player = Readonly<{ id: string; token: string }>;

const recordingStore = (upserts: Upsert[]): RankingStore => ({
  upsert: async (event, entry) => {
    upserts.push({ event, enrollment: entry.enrollmentId, score: entry.score });
  },
  remove: async () => undefined,
  read: async () => ({ top: [], total: 2, place: 1 }),
  rebuild: async () => "rebuilt",
  builtAt: async () => undefined,
});

const codeOf = (response: { statusCode: number; json: () => { code?: string } }) => [
  response.statusCode,
  response.json().code,
];
const reasonOf = (response: {
  statusCode: number;
  json: () => { code?: string; details?: Row };
}) => [response.statusCode, response.json().code, response.json().details?.["reason"]];

/**
 * Meet-someone over HTTP (T-303c): the code's shape, the state poll, a paying meeting and both rankings, every refusal's
 * answer, the limits, the switch, and that neither the token nor the other player's id ever leaves the server.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("meet-someone over HTTP", () => {
  let db: TestDatabase;
  let test: TestApp;
  let organizer = "";
  let ownerCookie = "";
  let counter = 0;
  const upserts: Upsert[] = [];
  const logs: string[] = [];
  let settingsPool: Pool;
  let settings: SettingsService;
  /** The HTTP replay store's clock: moved past a day, a replayed key reaches the database's own replay. */
  let clock = Date.now();

  beforeAll(async () => {
    db = await createTestDatabase();
    settingsPool = new Pool({ connectionString: db.appUrl, max: 2 });
    settings = createSettingsService({ pool: settingsPool });
    test = await startApp(
      db,
      { level: "debug", stream: { write: (line: string) => void logs.push(line) } },
      {},
      {
        rankingStore: recordingStore(upserts),
        settings,
        idempotencyStore: new MemoryIdempotencyStore(() => clock),
      },
    );
    organizer =
      (
        await db.owner.query<{ id: string }>(
          "INSERT INTO organizer (name, slug) VALUES ('meet-org', 'meet-org') RETURNING id",
        )
      ).rows[0]?.id ?? "";
    const id = await createStaff(db.owner, { email: "owner@meet.test" });
    await db.owner.query(
      "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, 'owner')",
      [organizer, id],
    );
    ownerCookie = await signInFully(test, "owner@meet.test");
  });
  afterAll(async () => {
    await test.close();
    await settingsPool.end();
    await db.close();
  });

  /** The meet log lines written since `from` lines were logged. */
  const meetLogs = (from = 0) =>
    logs
      .slice(from)
      .map((line) => JSON.parse(line) as Row)
      .filter((entry) => String(entry["event"]).startsWith("meet."));
  /** Runs `work` with the platform's location quests switched on. */
  const withLocationOn = async (work: () => Promise<void>) => {
    await db.owner.query("INSERT INTO platform_setting (key, value) VALUES ('features', $1)", [
      JSON.stringify({ locationQuests: { enabled: true } }),
    ]);
    settings.forget();
    try {
      await work();
    } finally {
      await db.owner.query("DELETE FROM platform_setting WHERE key = 'features'");
      settings.forget();
    }
  };

  const owner = async <T extends Row>(sql: string, values: unknown[] = []) =>
    (await db.owner.query<T>(sql, values)).rows;
  const newEvent = async (): Promise<string> => {
    counter += 1;
    const [event] = await owner<{ id: string }>(
      `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at)
       VALUES ($1, $2, 'Meet Fest', 'live', now() - interval '1 hour', now() + interval '1 day') RETURNING id`,
      [organizer, `MEETH${counter}`],
    );
    return event?.id ?? "";
  };
  const newQuest = async (event: string, dailyCap = 5, repeatCap = 10) =>
    (
      await owner<{ id: string }>(
        `INSERT INTO quest (event_id, category_id, type, title_en, points, repeat_cap, type_config)
         SELECT $1, id, 'meet', 'Meet', 50, $2, $3 FROM category WHERE event_id = $1 LIMIT 1 RETURNING id`,
        [event, repeatCap, JSON.stringify({ dailyCap })],
      )
    )[0]?.id ?? "";
  const newPlayer = async (event: string): Promise<Player> => {
    counter += 1;
    const [player] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`meet_http_${counter}`],
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
    return { id, token };
  };
  const call = (
    method: "GET" | "POST",
    path: string,
    who: Player,
    payload?: object,
    headers: Record<string, string> = {},
  ) =>
    test.app.inject({
      method,
      url: path,
      headers: {
        authorization: `Bearer ${who.token}`,
        "idempotency-key": randomUUID(),
        ...headers,
      },
      ...(payload === undefined ? {} : { payload }),
    });
  const show = async (who: Player, quest: string, device?: string) => {
    const response = await call(
      "POST",
      `/v1/quests/${quest}/meet-pass`,
      who,
      undefined,
      device === undefined ? {} : { "x-device-id": device },
    );
    return response.json<{ code: string; passId: string; expiresAt: string }>();
  };
  const scan = (who: Player, code: string, headers: Record<string, string> = {}) =>
    call("POST", "/v1/meet", who, { code }, headers);

  it("shows a code, pays both players, moves both places, and names the other by username only", async () => {
    const event = await newEvent();
    const quest = await newQuest(event);
    const [a, b] = [await newPlayer(event), await newPlayer(event)];
    const shown = await call("POST", `/v1/quests/${quest}/meet-pass`, b);
    expect(shown.statusCode).toBe(201);
    const pass = shown.json<{ code: string; passId: string; expiresAt: string }>();
    expect(pass.code).toMatch(/^questify\/meet\/v1\/[A-Za-z0-9_-]{22}$/);
    expect(Date.parse(pass.expiresAt) - Date.now()).toBeLessThanOrEqual(61_000);
    expect((await call("GET", `/v1/meet-passes/${pass.passId}`, b)).json()).toEqual({
      state: "open",
      met: null,
    });
    expect(codeOf(await call("GET", `/v1/meet-passes/${pass.passId}`, a))).toEqual([
      404,
      "not_found",
    ]);
    const token = pass.code.slice("questify/meet/v1/".length);
    const stored = await owner<{ token_hash: Buffer }>(
      "SELECT token_hash FROM meet_pass WHERE id = $1",
      [pass.passId],
    );
    expect(stored[0]?.token_hash.equals(createHash("sha256").update(token).digest())).toBe(true);

    const before = upserts.length;
    const logged = logs.length;
    const met = await scan(a, pass.code);
    expect(met.statusCode, met.body).toBe(200);
    expect(meetLogs(logged)).toEqual([
      expect.objectContaining({
        event: "meet.met",
        refusal: "done",
        reason: "done",
        replayed: "false",
      }),
    ]);
    const listed = await call("GET", `/v1/events/${event}/quests`, a);
    expect(
      listed.json<{ categories: { quests: Row[] }[] }>().categories[0]?.quests[0],
    ).toMatchObject({ id: quest, meet: { dailyCap: 5, today: 1 }, game: null });
    expect(met.json()).toMatchObject({
      points: 50,
      occurrence: 1,
      score: 50,
      replayed: false,
      questId: quest,
      met: { username: expect.stringMatching(/^meet_http_/), avatar: "falcon" },
      rank: 1,
    });
    expect(met.body).not.toContain(b.id);
    expect(Object.keys(met.json<Row>()).toSorted()).toEqual(
      [
        "balance",
        "bonus",
        "boost",
        "completionId",
        "firstBonus",
        "item",
        "levelUp",
        "met",
        "occurrence",
        "points",
        "questId",
        "rank",
        "replayed",
        "score",
        "streakBonus",
      ].toSorted(),
    );
    // The whole event's board and today's board (a multi-day event), for both players.
    expect(upserts.slice(before).map((write) => write.score)).toEqual([50n, 50n, 50n, 50n]);
    expect(new Set(upserts.slice(before).map((write) => write.enrollment)).size).toBe(2);
    expect((await call("GET", `/v1/meet-passes/${pass.passId}`, b)).json()).toEqual({
      state: "used",
      met: { username: expect.stringMatching(/^meet_http_/), avatar: "falcon", points: 50 },
    });
  });

  it("answers a replay with the first meeting and moves no place again", async () => {
    const event = await newEvent();
    const quest = await newQuest(event);
    const [a, b] = [await newPlayer(event), await newPlayer(event)];
    const { code } = await show(b, quest);
    const key = { "idempotency-key": randomUUID() };
    const first = await scan(a, code, key);
    const writes = upserts.length;
    const again = await scan(a, code, key);
    expect(again.json()).toMatchObject({ completionId: first.json().completionId });
    expect(upserts.length - writes).toBeLessThanOrEqual(1);
    clock += 2 * 24 * 60 * 60 * 1000;
    const logged = logs.length;
    const replayed = await scan(a, code, key);
    expect(replayed.json()).toMatchObject({
      completionId: first.json().completionId,
      replayed: true,
    });
    const [shown] = await owner<{ id: string }>(
      "SELECT id FROM enrollment WHERE event_id = $1 AND player_id = $2",
      [event, b.id],
    );
    expect(upserts.slice(writes).map((write) => write.enrollment)).not.toContain(shown?.id);
    expect(meetLogs(logged)).toEqual([
      expect.objectContaining({ event: "meet.met", replayed: "true" }),
    ]);
  });

  it("answers each refusal with its status and reason, and never echoes the code", async () => {
    const event = await newEvent();
    const quest = await newQuest(event, 1, 10);
    const [a, b, c] = [await newPlayer(event), await newPlayer(event), await newPlayer(event)];
    const own = await show(a, quest);
    const logged = logs.length;
    expect(reasonOf(await scan(a, own.code))).toEqual([422, "meet_refused", "self"]);
    expect(meetLogs(logged)).toEqual([
      expect.objectContaining({
        event: "meet.refused",
        refusal: "meet_refused",
        reason: "self",
        replayed: "",
      }),
    ]);
    const phone = randomUUID();
    const onPhone = await show(b, quest, phone);
    expect(reasonOf(await scan(a, onPhone.code, { "x-device-id": phone }))).toEqual([
      422,
      "meet_refused",
      "same_device",
    ]);
    const forged = "questify/meet/v1/AAAAAAAAAAAAAAAAAAAAAA";
    const bad = await scan(a, forged);
    expect(reasonOf(bad)).toEqual([422, "meet_refused", "bad_code"]);
    expect(bad.body).not.toContain("AAAAAAAAAAAAAAAAAAAAAA");
    expect(reasonOf(await scan(a, "https://questify.nafes.com/q/abc"))).toEqual([
      422,
      "meet_refused",
      "bad_code",
    ]);
    expect(codeOf(await call("POST", "/v1/meet", a, { code: 5 }))).toEqual([
      400,
      "invalid_request",
    ]);

    const fresh = await show(b, quest);
    await scan(a, fresh.code);
    expect(reasonOf(await scan(c, fresh.code))).toEqual([422, "meet_refused", "used"]);
    const capped = await scan(a, (await show(c, quest)).code);
    expect([capped.statusCode, capped.json().code, capped.json().details]).toEqual([
      409,
      "meet_refused",
      { reason: "daily_cap", cap: 1 },
    ]);
    expect(codeOf(await call("POST", `/v1/quests/${quest}/meet-pass`, a))).toEqual([
      409,
      "meet_refused",
    ]);

    const other = await newEvent();
    const stranger = await newPlayer(other);
    const theirs = await show(c, quest);
    const outside = await scan(stranger, theirs.code);
    expect(reasonOf(outside)).toEqual([403, "meet_refused", "not_in_event"]);
    expect(outside.json().details).toEqual({ reason: "not_in_event" });
    expect(logs.join("\n")).not.toContain(theirs.code.slice(-22));
    expect(logs.join("\n")).not.toContain(forged.slice(-22));
  });

  it("names the other player on already_met, refuses another type and a missing key", async () => {
    const event = await newEvent();
    const quest = await newQuest(event);
    const [a, b] = [await newPlayer(event), await newPlayer(event)];
    await scan(a, (await show(b, quest)).code);
    const again = await scan(b, (await show(a, quest)).code);
    expect(reasonOf(again)).toEqual([409, "meet_refused", "already_met"]);
    expect(again.json().details?.["name"]).toMatch(/^meet_http_/);
    const [scanQuest] = await owner<{ id: string }>(
      `INSERT INTO quest (event_id, category_id, type, title_en, points)
       SELECT $1, id, 'scan_qr', 'Scan', 5 FROM category WHERE event_id = $1 LIMIT 1 RETURNING id`,
      [event],
    );
    expect(codeOf(await call("POST", `/v1/quests/${scanQuest?.id}/meet-pass`, a))).toEqual([
      422,
      "not_meet_quest",
    ]);
    const keyless = await test.app.inject({
      method: "POST",
      url: "/v1/meet",
      headers: { authorization: `Bearer ${a.token}` },
      payload: { code: "x" },
    });
    expect(keyless.statusCode).toBe(400);
  });

  it("holds refused scans to 20 per player in 10 minutes", async () => {
    const event = await newEvent();
    const a = await newPlayer(event);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      expect(reasonOf(await scan(a, `questify/meet/v1/${"B".repeat(22)}`))[2]).toBe("bad_code");
    }
    const limited = await scan(a, `questify/meet/v1/${"B".repeat(22)}`);
    expect(codeOf(limited)).toEqual([429, "too_many_attempts"]);
    expect(limited.headers["retry-after"]).toBeDefined();
    expect(limited.json().details).toEqual({
      retryAfterSeconds: Number(limited.headers["retry-after"]),
    });
  });

  it("never counts a paying meeting against the refused scans", async () => {
    const event = await newEvent();
    const quest = await newQuest(event);
    const [a, b] = [await newPlayer(event), await newPlayer(event)];
    expect((await scan(a, (await show(b, quest)).code)).statusCode).toBe(200);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      expect(reasonOf(await scan(a, `questify/meet/v1/${"C".repeat(22)}`))[2]).toBe("bad_code");
    }
    expect(codeOf(await scan(a, `questify/meet/v1/${"C".repeat(22)}`))).toEqual([
      429,
      "too_many_attempts",
    ]);
  });

  it("holds codes shown to 30 per player in 10 minutes, and state reads to 60 a minute", async () => {
    const event = await newEvent();
    const quest = await newQuest(event);
    const a = await newPlayer(event);
    let pass = { passId: "" };
    for (let attempt = 0; attempt < 30; attempt += 1) {
      pass = await show(a, quest);
    }
    const shownLimited = await call("POST", `/v1/quests/${quest}/meet-pass`, a);
    expect(codeOf(shownLimited)).toEqual([429, "too_many_attempts"]);
    expect(shownLimited.json().details).toEqual({
      retryAfterSeconds: Number(shownLimited.headers["retry-after"]),
    });
    for (let attempt = 0; attempt < 60; attempt += 1) {
      expect((await call("GET", `/v1/meet-passes/${pass.passId}`, a)).statusCode).toBe(200);
    }
    const readLimited = await call("GET", `/v1/meet-passes/${pass.passId}`, a);
    expect(codeOf(readLimited)).toEqual([429, "too_many_attempts"]);
    expect(readLimited.headers["retry-after"]).toBeDefined();
  });

  it("takes no body when showing a code", async () => {
    const event = await newEvent();
    const quest = await newQuest(event);
    const a = await newPlayer(event);
    expect(codeOf(await call("POST", `/v1/quests/${quest}/meet-pass`, a, { x: 1 }))).toEqual([
      400,
      "invalid_request",
    ]);
  });

  /** How many of the player's completions kept a position. */
  const positionsKept = async (who: Player) =>
    (
      await owner(
        `SELECT 1 FROM completion_position p JOIN enrollment n ON n.id = p.enrollment_id
         WHERE n.player_id = $1`,
        [who.id],
      )
    ).length;

  it("keeps the scanner's well-formed position only while location quests are on, and drops a bad one", async () => {
    const event = await newEvent();
    const quest = await newQuest(event);
    const position = { lat: 24.7136, lng: 46.6753, accuracyM: 12, ageS: 3 };
    const meetWith = async (reading: unknown) => {
      const [a, b] = [await newPlayer(event), await newPlayer(event)];
      const { code } = await show(b, quest);
      const met = await call("POST", "/v1/meet", a, { code, position: reading });
      expect(met.statusCode, met.body).toBe(200);
      return positionsKept(a);
    };
    expect(await meetWith(position)).toBe(0);
    await withLocationOn(async () => {
      expect(await meetWith(position)).toBe(1);
      expect(await meetWith({ ...position, lat: 91 })).toBe(0);
      expect(await meetWith(undefined)).toBe(0);
    });
  });

  it("lets the owner switch meet quests off, which hides them and refuses codes and scans", async () => {
    const event = await newEvent();
    const quest = await newQuest(event);
    const [a, b] = [await newPlayer(event), await newPlayer(event)];
    const pass = await show(b, quest);
    const off = await test.app.inject({
      method: "PUT",
      url: `/v1/organizers/${organizer}/events/${event}/meet-someone`,
      headers: withSession(ownerCookie, { "idempotency-key": randomUUID() }),
      payload: { enabled: false },
    });
    expect([off.statusCode, off.json()]).toEqual([200, { meetSomeone: false }]);
    expect(codeOf(await call("POST", `/v1/quests/${quest}/meet-pass`, b))).toEqual([
      403,
      "feature_off",
    ]);
    expect(codeOf(await scan(a, pass.code))).toEqual([403, "feature_off"]);
    const quests = await call("GET", `/v1/events/${event}/quests`, a);
    expect(quests.body).not.toContain(quest);
  });

  it("refuses a daily cap above the repeat cap in the builder", async () => {
    const event = await newEvent();
    const [category] = await owner<{ id: string }>(
      "SELECT id FROM category WHERE event_id = $1 LIMIT 1",
      [event],
    );
    const create = (repeatCap: number, dailyCap: number) =>
      test.app.inject({
        method: "POST",
        url: `/v1/organizers/${organizer}/events/${event}/quests`,
        headers: withSession(ownerCookie, { "idempotency-key": randomUUID() }),
        payload: {
          categoryId: category?.id,
          type: "meet",
          title: { en: "Meet" },
          points: 20,
          repeatCap,
          config: { dailyCap },
        },
      });
    const refused = await create(3, 5);
    expect([refused.statusCode, refused.json().details]).toEqual([422, { field: "dailyCap" }]);
    const made = await create(10, 5);
    expect(made.statusCode, made.body).toBe(201);
    expect(made.json()).toMatchObject({
      quest: { type: "meet", repeatCap: 10, config: { dailyCap: 5 }, verification: [] },
    });
  });
});
