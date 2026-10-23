import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { memoryMatchV1, replay, type MemoryInput, type MemoryParams } from "@questify/shared";
import type { RankingStore } from "#src/ranking/store";
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
type Issued = {
  roundId: string;
  seed: number;
  params: MemoryParams;
  replayed: boolean;
  attemptsLeft: number | null;
};

const recordingStore = (upserts: Upsert[]): RankingStore => ({
  upsert: async (event, entry) => {
    upserts.push({ event, enrollment: entry.enrollmentId, score: entry.score });
  },
  remove: async () => undefined,
  read: async () => ({ top: [], total: 1, place: 1 }),
  rebuild: async () => "rebuilt",
  builtAt: async () => undefined,
});

const codeOf = (response: { statusCode: number; json: () => { code?: string } }) => [
  response.statusCode,
  response.json().code,
];
const ENGINES = { engineVersions: { memory_match: 1, slide_puzzle: 1 } };

/** The flips of a player who finds every pair in turn, 150 ms apart, and the result the app claims for them. */
function perfectPlay(round: Issued): { inputs: MemoryInput[]; claimed: unknown } {
  const deck = memoryMatchV1.start(round.seed, round.params).deck;
  const inputs: MemoryInput[] = [];
  for (let picture = 0; picture < round.params.pairs; picture += 1) {
    for (const card of deck.flatMap((face, index) => (face === picture ? [index] : []))) {
      inputs.push({ t: (inputs.length + 1) * 150, card });
    }
  }
  const played = replay(memoryMatchV1, round.seed, round.params, inputs);
  return { inputs, claimed: "result" in played ? played.result : null };
}

/**
 * Mini-games over HTTP (T-305): the sheet, a round issued on Play and its replayed key, the update answer, the result
 * replayed on the server and paid once, every refusal's answer, the reason never sent, the limits, the switch and the
 * builder's games not available yet.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("mini-games over HTTP", () => {
  let db: TestDatabase;
  let test: TestApp;
  let organizer = "";
  let ownerCookie = "";
  let counter = 0;
  const upserts: Upsert[] = [];
  const logs: string[] = [];

  beforeAll(async () => {
    db = await createTestDatabase();
    test = await startApp(
      db,
      { level: "debug", stream: { write: (line: string) => void logs.push(line) } },
      {},
      { rankingStore: recordingStore(upserts) },
    );
    organizer =
      (
        await db.owner.query<{ id: string }>(
          "INSERT INTO organizer (name, slug) VALUES ('game-org', 'game-org') RETURNING id",
        )
      ).rows[0]?.id ?? "";
    const id = await createStaff(db.owner, { email: "owner@game.test" });
    await db.owner.query(
      "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, 'owner')",
      [organizer, id],
    );
    ownerCookie = await signInFully(test, "owner@game.test");
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
       VALUES ($1, $2, 'Game Fest', 'live', now() - interval '1 hour', now() + interval '1 day') RETURNING id`,
      [organizer, `GAMEH${counter}`],
    );
    return event?.id ?? "";
  };
  const newQuest = async (event: string, config: Row = {}) =>
    (
      await owner<{ id: string }>(
        `INSERT INTO quest (event_id, category_id, type, title_en, points, type_config)
         SELECT $1, id, 'game', 'Play', 40, $2 FROM category WHERE event_id = $1 LIMIT 1 RETURNING id`,
        [
          event,
          JSON.stringify({
            game: "memory_match",
            level: "easy",
            attempts: 1,
            cooldownMinutes: null,
            ...config,
          }),
        ],
      )
    )[0]?.id ?? "";
  const newPlayer = async (event: string): Promise<Player> => {
    counter += 1;
    const [player] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`game_http_${counter}`],
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
    payload?: unknown,
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
      ...(payload === undefined ? {} : { payload: payload as Row }),
    });
  const play = async (who: Player, quest: string, headers: Record<string, string> = {}) =>
    call("POST", `/v1/quests/${quest}/game-rounds`, who, ENGINES, headers);
  const issued = async (who: Player, quest: string) => (await play(who, quest)).json<Issued>();
  const send = (who: Player, round: string, body: unknown, headers: Record<string, string> = {}) =>
    call("POST", `/v1/game-rounds/${round}/result`, who, body, headers);
  const roundRow = async (round: string) =>
    (
      await owner<Row>("SELECT status, reason, result_key FROM game_round WHERE id = $1", [round])
    )[0];

  it("shows the sheet, issues a round, replays its key and pays a perfect game once, moving the place", async () => {
    const event = await newEvent();
    const quest = await newQuest(event, { attempts: 2 });
    const a = await newPlayer(event);
    const sheet = await call("GET", `/v1/quests/${quest}/game`, a);
    expect(sheet.json()).toMatchObject({
      game: "memory_match",
      level: "easy",
      target: { game: "memory_match", pairs: 6, maxMoves: null },
      attempts: 2,
      used: 0,
      attemptsLeft: 2,
      passed: false,
      open: null,
      last: null,
    });
    const key = { "idempotency-key": randomUUID() };
    const first = await play(a, quest, key);
    expect(first.statusCode, first.body).toBe(201);
    const round = first.json<Issued>();
    expect(round).toMatchObject({
      game: "memory_match",
      engineVersion: 1,
      attemptsLeft: 1,
      replayed: false,
    });
    const again = await call("POST", `/v1/quests/${quest}/game-rounds`, a, ENGINES, key);
    expect(again.json()).toMatchObject({ roundId: round.roundId });

    const before = upserts.length;
    const paid = await send(a, round.roundId, perfectPlay(round));
    expect(paid.statusCode, paid.body).toBe(200);
    expect(paid.json()).toMatchObject({
      verdict: "passed",
      result: { pairs: 6, moves: 6 },
      target: { pairs: 6 },
      points: 40,
      score: 40,
      replayed: false,
      rank: 1,
    });
    expect(upserts.length).toBeGreaterThan(before);
    expect(codeOf(await play(a, quest))).toEqual([409, "already_completed"]);
    const second = await send(a, round.roundId, perfectPlay(round));
    expect([second.statusCode, second.json().details]).toEqual([409, { reason: "finished" }]);
  });

  it("answers 426 to an app whose engine is older than the server's, writing no round", async () => {
    const event = await newEvent();
    const quest = await newQuest(event);
    const a = await newPlayer(event);
    for (const engineVersions of [{}, { memory_match: 0 }, { slide_puzzle: 1 }]) {
      expect(
        codeOf(await call("POST", `/v1/quests/${quest}/game-rounds`, a, { engineVersions })),
      ).toEqual([426, "update_required"]);
    }
    expect(await owner("SELECT 1 FROM game_round WHERE quest_id = $1", [quest])).toEqual([]);
    expect((await play(a, quest)).statusCode).toBe(201);
  });

  it("never pays a claimed score alone: passing claims over failing inputs are refused, the reason kept back", async () => {
    const event = await newEvent();
    const quest = await newQuest(event);
    const a = await newPlayer(event);
    const round = await issued(a, quest);
    const { inputs, claimed } = perfectPlay(round);
    const refused = await send(a, round.roundId, { inputs: inputs.slice(0, 4), claimed });
    expect([refused.statusCode, refused.json().code, refused.json().details]).toEqual([
      422,
      "game_refused",
      { reason: "impossible", attemptsLeft: 0 },
    ]);
    expect(refused.body).not.toContain("claimed");
    expect(await roundRow(round.roundId)).toMatchObject({ status: "refused", reason: "claimed" });
    expect(
      await owner(
        "SELECT f.kind FROM flag f JOIN enrollment n ON n.id = f.enrollment_id WHERE n.player_id = $1",
        [a.id],
      ),
    ).toEqual([{ kind: "minigame" }]);
    expect(await owner("SELECT 1 FROM quest_completion WHERE quest_id = $1", [quest])).toEqual([]);
  });

  it("closes a round with malformed inputs as a refused row written through finish_game_round (never by a raise)", async () => {
    const event = await newEvent();
    const quest = await newQuest(event);
    const a = await newPlayer(event);
    const round = await issued(a, quest);
    const refused = await send(a, round.roundId, { inputs: "nonsense", claimed: 7 });
    expect([refused.statusCode, refused.json().details]).toEqual([
      422,
      { reason: "impossible", attemptsLeft: 0 },
    ]);
    expect(await roundRow(round.roundId)).toMatchObject({ status: "refused", reason: "malformed" });
    const missing = await issued(await newPlayer(event), quest);
    expect((await send(await newPlayer(event), missing.roundId, {})).statusCode).toBe(404);
  });

  it("answers a short round with its result and the target, and another player's round as not found", async () => {
    const event = await newEvent();
    const quest = await newQuest(event, { level: "medium", attempts: 3 });
    const a = await newPlayer(event);
    const round = await issued(a, quest);
    const inputs = perfectPlay(round).inputs.slice(0, 2);
    const played = replay(memoryMatchV1, round.seed, round.params, inputs);
    const short = await send(a, round.roundId, {
      inputs,
      claimed: "result" in played ? played.result : null,
    });
    expect(short.json()).toMatchObject({
      verdict: "short",
      result: { pairs: 1, moves: 1 },
      target: { pairs: 8, maxMoves: 20 },
      attemptsLeft: 2,
      completionId: null,
      rank: null,
    });
    const b = await newPlayer(event);
    expect(codeOf(await send(b, round.roundId, perfectPlay(round)))).toEqual([404, "not_found"]);
  });

  it("refuses a body over 64 KiB", async () => {
    const event = await newEvent();
    const a = await newPlayer(event);
    const round = await issued(a, await newQuest(event));
    const huge = { inputs: [{ t: 0, card: 0, pad: "x".repeat(70_000) }], claimed: null };
    expect((await send(a, round.roundId, huge)).statusCode).toBe(413);
  });

  it("answers attempts_used and the cooldown with its retry time", async () => {
    const event = await newEvent();
    const a = await newPlayer(event);
    const once = await newQuest(event);
    await issued(a, once);
    const used = await play(a, once);
    expect([used.statusCode, used.json().details]).toEqual([409, { reason: "attempts_used" }]);
    const unlimited = await newQuest(event, { attempts: null, cooldownMinutes: 10 });
    await issued(a, unlimited);
    const cooling = await play(a, unlimited);
    expect(cooling.statusCode).toBe(409);
    expect(cooling.json().details).toMatchObject({
      reason: "cooldown",
      retryAt: expect.stringMatching(/Z$/),
    });
    expect(Date.parse(cooling.json().details.retryAt) - Date.now()).toBeGreaterThan(590_000);
  });

  it("holds Play to 30 rounds per player per 10 minutes", async () => {
    const event = await newEvent();
    const quest = await newQuest(event);
    const a = await newPlayer(event);
    for (let index = 0; index < 30; index += 1) {
      expect(
        (await call("POST", `/v1/quests/${quest}/game-rounds`, a, { engineVersions: {} }))
          .statusCode,
      ).toBe(426);
    }
    const limited = await play(a, quest);
    expect(codeOf(limited)).toEqual([429, "too_many_attempts"]);
    expect(limited.headers["retry-after"]).toBeDefined();
  });

  it("holds results to 20 per player per 10 minutes", async () => {
    const event = await newEvent();
    const a = await newPlayer(event);
    for (let index = 0; index < 20; index += 1) {
      expect((await send(a, "999999999", { inputs: [], claimed: null })).statusCode).toBe(404);
    }
    expect(codeOf(await send(a, "999999999", { inputs: [], claimed: null }))).toEqual([
      429,
      "too_many_attempts",
    ]);
  });

  it("lets the owner switch mini-games off, which hides them and refuses Play, while an issued round still counts", async () => {
    const event = await newEvent();
    const quest = await newQuest(event);
    const a = await newPlayer(event);
    const round = await issued(a, quest);
    const off = await test.app.inject({
      method: "PUT",
      url: `/v1/organizers/${organizer}/events/${event}/mini-games`,
      headers: withSession(ownerCookie, { "idempotency-key": randomUUID() }),
      payload: { enabled: false },
    });
    expect([off.statusCode, off.json()]).toEqual([200, { miniGames: false }]);
    expect(codeOf(await play(await newPlayer(event), quest))).toEqual([403, "feature_off"]);
    expect((await call("GET", `/v1/events/${event}/quests`, a)).body).not.toContain(quest);
    expect((await send(a, round.roundId, perfectPlay(round))).json()).toMatchObject({
      verdict: "passed",
    });
  });

  it("builds a game quest and answers the games not available yet", async () => {
    const event = await newEvent();
    const [category] = await owner<{ id: string }>(
      "SELECT id FROM category WHERE event_id = $1 LIMIT 1",
      [event],
    );
    const create = (config: Row) =>
      test.app.inject({
        method: "POST",
        url: `/v1/organizers/${organizer}/events/${event}/quests`,
        headers: withSession(ownerCookie, { "idempotency-key": randomUUID() }),
        payload: {
          categoryId: category?.id,
          type: "game",
          title: { en: "Play" },
          points: 20,
          config,
        },
      });
    const refused = await create({ game: "tap_rush", level: "easy" });
    expect([refused.statusCode, refused.json().details]).toEqual([
      422,
      { field: "game", reason: "not_available" },
    ]);
    const made = await create({
      game: "slide_puzzle",
      level: "medium",
      attempts: null,
      cooldownMinutes: 30,
    });
    expect(made.statusCode, made.body).toBe(201);
    expect(made.json()).toMatchObject({
      quest: {
        type: "game",
        repeatCap: 1,
        verification: [],
        config: { game: "slide_puzzle", level: "medium", attempts: null, cooldownMinutes: 30 },
      },
    });
  });

  it("never logs the inputs or the seed", () => {
    const joined = logs.join("\n");
    expect(joined).toContain("game.result");
    expect(joined).not.toMatch(/"inputs"|"seed"/);
  });
});
