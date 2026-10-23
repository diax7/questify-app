import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LEVELS } from "@questify/shared";
import { withRequestContext, type RequestContext } from "#src/db/context";
import {
  TEST_DATABASE_URL,
  addMember,
  createTestDatabase,
  seedTwoTenants,
  type TestDatabase,
} from "#test/support/test-db";

type Row = Record<string, unknown>;
type Member = { player: string; enrollment: string };
type Round = {
  round_id: string;
  game: string;
  level: string;
  seed: number;
  params: Row;
  points: number;
  engine_version: number;
  deadline_at: Date;
  attempts_left: number | null;
  replayed: boolean;
};
type Finished = {
  verdict: string;
  completion_id: string | null;
  points: string | null;
  score: string;
  attempts_left: number | null;
  replayed: boolean;
  result: Row | null;
};
type Verdict = Readonly<{
  verdict?: string;
  result?: Row | null;
  reason?: string | null;
  unlikely?: boolean;
  lastMs?: number;
  key?: string;
}>;
type GameConfig = Readonly<{
  game?: string;
  level?: string;
  attempts?: number | null;
  cooldownMinutes?: number | null;
}>;

const refusal = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
    return "none";
  } catch (error) {
    const pg = error as { code?: string; detail?: string };
    return pg.detail === undefined || pg.detail === "" || !String(pg.code).startsWith("Q")
      ? `${pg.code}`
      : `${pg.code}:${pg.detail}`;
  }
};

const as = (player: string): RequestContext => ({ playerId: player });
const configOf = (config: GameConfig) => ({
  game: config.game ?? "memory_match",
  level: config.level ?? "easy",
  attempts: config.attempts === undefined ? 1 : config.attempts,
  cooldownMinutes: config.cooldownMinutes ?? null,
});
const PASS = { pairs: 6, moves: 9, ms: 30_000, lucky: 0 };
const SHORT = { pairs: 4, moves: 30, ms: 120_000, lucky: 0 };

/**
 * Mini-game rounds in the database (T-305, migration 0050, ADR-212, ADR-213): the issue and its attempt, the replayed
 * keys, the verdicts, the clock and the window, one payment on the first pass, the flags, the sweep, leaving, the
 * spent last attempt, the locks on a played quest, erasure, the wipe, the races and the closed doors.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("mini-game rounds (database)", () => {
  let db: TestDatabase;
  let pool: Pool;
  let ids: Awaited<ReturnType<typeof seedTwoTenants>>;
  let ownerA = "";
  let ownerB = "";
  let counter = 0;

  beforeAll(async () => {
    db = await createTestDatabase();
    pool = new Pool({ connectionString: db.appUrl, max: 8 });
    ids = await seedTwoTenants(db.owner);
    ownerA = await addMember(db.owner, ids.orgA, "owner");
    ownerB = await addMember(db.owner, ids.orgB, "owner");
  });
  afterAll(async () => {
    await pool.end();
    await db.close();
  });

  const owner = async <T extends Row>(sql: string, values: unknown[] = []) =>
    (await db.owner.query<T>(sql, values)).rows;
  const query = async <T extends Row>(
    context: RequestContext,
    sql: string,
    values: unknown[] = [],
  ) => {
    const client: PoolClient = await pool.connect();
    try {
      return await withRequestContext(
        client,
        context,
        async () => (await client.query<T>(sql, values)).rows,
      );
    } finally {
      client.release();
    }
  };
  const teamA = (): RequestContext => ({ organizerId: ids.orgA, staffUserId: ownerA });

  const newEvent = async (status = "live", organizer?: string): Promise<string> => {
    counter += 1;
    const [event] = await owner<{ id: string }>(
      `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at)
       VALUES ($1, $2, 'Game Fest', $3, now() - interval '1 hour', now() + interval '1 day') RETURNING id`,
      [organizer ?? ids.orgA, `GAME${counter}`, status],
    );
    return event?.id ?? "";
  };
  const newCategory = async (event: string, fields: Row = {}) =>
    (
      await owner<{ id: string }>(
        `INSERT INTO category (event_id, name_en, completion_bonus, order_mode)
         VALUES ($1, 'Games', $2, $3) RETURNING id`,
        [event, fields["bonus"] ?? 0, fields["order"] ?? "any"],
      )
    )[0]?.id ?? "";
  const newQuest = async (
    event: string,
    config: GameConfig = {},
    options: Readonly<{ category?: string; points?: number; position?: number }> = {},
  ) => {
    const category = options.category ?? (await newCategory(event));
    const [quest] = await owner<{ id: string }>(
      `INSERT INTO quest (event_id, category_id, type, title_en, points, type_config, position)
       VALUES ($1, $2, 'game', 'Play', $3, $4, $5) RETURNING id`,
      [
        event,
        category,
        options.points ?? 40,
        JSON.stringify(configOf(config)),
        options.position ?? 0,
      ],
    );
    return quest?.id ?? "";
  };
  const member = async (event: string, via = "code", organizer?: string): Promise<Member> => {
    counter += 1;
    const [player] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`game_player_${counter}`],
    );
    const [made] = await owner<{ id: string }>(
      "INSERT INTO enrollment (organizer_id, event_id, player_id, joined_via) VALUES ($1, $2, $3, $4) RETURNING id",
      [organizer ?? ids.orgA, event, player?.id, via],
    );
    return { player: player?.id ?? "", enrollment: made?.id ?? "" };
  };
  const start = async (
    who: Member,
    quest: string,
    key = randomUUID(),
    device: string | null = null,
  ) =>
    (
      await query<Round>(as(who.player), "SELECT * FROM start_game_round($1, $2, $3, 1)", [
        quest,
        key,
        device,
      ])
    )[0] as Round;
  const finish = async (who: Member, round: string, given: Verdict = {}) => {
    const verdict = given.verdict ?? "passed";
    const result =
      given.result === undefined ? (verdict === "refused" ? null : PASS) : given.result;
    return (
      await query<Finished>(
        as(who.player),
        "SELECT * FROM finish_game_round($1, $2, $3, $4, $5, $6, $7)",
        [
          round,
          given.key ?? randomUUID(),
          verdict,
          result === null ? null : JSON.stringify(result),
          given.reason === undefined ? (verdict === "refused" ? "illegal" : null) : given.reason,
          given.unlikely ?? false,
          given.lastMs ?? 0,
        ],
      )
    )[0] as Finished;
  };
  const roundOf = async (round: string) =>
    (await owner<Row>("SELECT * FROM game_round WHERE id = $1", [round]))[0] as Row;
  const completions = (enrollment: string) =>
    owner<{ method: string; idempotency_key: string; device_id: string | null }>(
      "SELECT method, idempotency_key, device_id FROM quest_completion WHERE enrollment_id = $1 ORDER BY id",
      [enrollment],
    );
  const ledger = (enrollment: string) =>
    owner<{ kind: string; score_delta: string }>(
      "SELECT kind, score_delta FROM ledger_entry WHERE enrollment_id = $1 ORDER BY id",
      [enrollment],
    );
  const flagOf = async (who: Member) =>
    (
      await owner<{ evidence: { rounds: Row[] }; status: string }>(
        "SELECT evidence, status FROM flag WHERE enrollment_id = $1 AND kind = 'minigame'",
        [who.enrollment],
      )
    )[0];
  const done = async (who: Member, quest: string) =>
    (
      await owner<{ done: boolean }>("SELECT quest_done($1, $2) AS done", [who.enrollment, quest])
    )[0]?.done;
  const sweep = async () =>
    (await query<{ outcome: string | null }>({}, "SELECT close_one_due_round() AS outcome"))[0]
      ?.outcome;
  const pastDeadline = (round: string) =>
    owner(
      `UPDATE game_round SET issued_at = now() - interval '20 minutes', deadline_at = now() - interval '1 second'
       WHERE id = $1`,
      [round],
    );
  const setup = async (config: GameConfig = {}) => {
    const event = await newEvent();
    const quest = await newQuest(event, config);
    return { event, quest, a: await member(event) };
  };

  describe("issuing a round", () => {
    it("freezes the seed, the level's numbers, the points and the engine version, and uses an attempt", async () => {
      const { quest, a } = await setup({ attempts: 3, level: "medium" });
      const round = await start(a, quest);
      expect(round).toMatchObject({
        game: "memory_match",
        level: "medium",
        params: LEVELS.memory_match.medium,
        points: 40,
        engine_version: 1,
        attempts_left: 2,
        replayed: false,
      });
      expect(Number.isInteger(round.seed)).toBe(true);
      const row = await roundOf(round.round_id);
      const window = (row["deadline_at"] as Date).getTime() - (row["issued_at"] as Date).getTime();
      expect(window).toBe((120 + 600) * 1000);
      expect(row).toMatchObject({ status: "open", engine_version: 1 });
    });

    it("issues catch and tap rush rounds with their levels and a window of their length plus 10 minutes, and pays a pass once, closing the quest (T-305c)", async () => {
      const passes = {
        catch: { caught: 25, missed: 5, foreseen: 0 },
        tap_rush: { hits: 30, misses: 2, score: 28, quick: 1 },
      };
      for (const game of ["catch", "tap_rush"] as const) {
        const { quest, a } = await setup({ game, level: "medium", attempts: 2 });
        const round = await start(a, quest);
        expect(round, game).toMatchObject({
          game,
          level: "medium",
          params: LEVELS[game].medium,
          engine_version: 1,
          attempts_left: 1,
        });
        const row = await roundOf(round.round_id);
        const window =
          (row["deadline_at"] as Date).getTime() - (row["issued_at"] as Date).getTime();
        expect(window, game).toBe((LEVELS[game].medium.timeLimitSeconds + 600) * 1000);
        expect(await finish(a, round.round_id, { result: passes[game] }), game).toMatchObject({
          verdict: "passed",
          points: "40",
        });
        expect(await refusal(start(a, quest)), game).not.toBe("none");
        expect(await ledger(a.enrollment), game).toHaveLength(1);
      }
    });

    it("draws different seeds, signed integers, from round to round", async () => {
      const { event } = await setup();
      const seeds = new Set<number>();
      for (let index = 0; index < 8; index += 1) {
        const quest = await newQuest(event);
        seeds.add((await start(await member(event), quest)).seed);
      }
      expect(seeds.size).toBe(8);
    });

    it("answers a replayed issue key with the same open round, using no attempt", async () => {
      const { event, quest, a } = await setup({ attempts: 2 });
      const key = randomUUID();
      const first = await start(a, quest, key);
      const again = await start(a, quest, key);
      expect(again).toMatchObject({
        round_id: first.round_id,
        seed: first.seed,
        replayed: true,
        attempts_left: 1,
      });
      expect(
        await owner("SELECT 1 FROM game_round WHERE enrollment_id = $1", [a.enrollment]),
      ).toHaveLength(1);
      const other = await newQuest(event);
      expect(await refusal(start(a, other, key))).toBe("QK422");
    });

    it("answers a replayed issue key on a round past its window `expired`, and on a finished one `finished`", async () => {
      const { quest, a } = await setup({ attempts: 3 });
      const key = randomUUID();
      const first = await start(a, quest, key);
      await pastDeadline(first.round_id);
      expect(await refusal(start(a, quest, key))).toBe("QG409:expired");
      const second = randomUUID();
      const next = await start(a, quest, second);
      await finish(a, next.round_id, { verdict: "short", result: SHORT });
      expect(await refusal(start(a, quest, second))).toBe("QG409:finished");
      expect(
        await owner("SELECT 1 FROM game_round WHERE enrollment_id = $1", [a.enrollment]),
      ).toHaveLength(2);
    });

    it("ends the player's open round of the quest when a new one starts", async () => {
      const { quest, a } = await setup({ attempts: 3 });
      const first = await start(a, quest);
      const second = await start(a, quest);
      expect(await roundOf(first.round_id)).toMatchObject({ status: "abandoned" });
      expect(await roundOf(second.round_id)).toMatchObject({ status: "open" });
      await pastDeadline(second.round_id);
      await start(a, quest);
      expect(await roundOf(second.round_id)).toMatchObject({ status: "expired" });
    });

    it("refuses a second round with one attempt, and a fourth with three", async () => {
      const one = await setup();
      await start(one.a, one.quest);
      expect(await refusal(start(one.a, one.quest))).toBe("QG409:attempts_used");
      const three = await setup({ attempts: 3 });
      for (let index = 0; index < 3; index += 1) {
        await start(three.a, three.quest);
      }
      expect(await refusal(start(three.a, three.quest))).toBe("QG409:attempts_used");
    });

    it("keeps unlimited attempts behind the cooldown, with the retry time, to the second", async () => {
      const { quest, a } = await setup({ attempts: null, cooldownMinutes: 5 });
      const first = await start(a, quest);
      expect(first.attempts_left).toBeNull();
      const refused = start(a, quest).catch(
        (error: { code: string; detail: string; hint: string }) => error,
      );
      expect(await refused).toMatchObject({ code: "QG409", detail: "cooldown" });
      const hint = ((await refused) as { hint: string }).hint;
      expect(new Date(hint).getTime() - (first.deadline_at.getTime() - 720_000)).toBeGreaterThan(
        299_000,
      );
      await owner(
        "UPDATE game_round SET issued_at = now() - interval '299 seconds' WHERE id = $1",
        [first.round_id],
      );
      expect(await refusal(start(a, quest))).toBe("QG409:cooldown");
      await owner(
        "UPDATE game_round SET issued_at = now() - interval '301 seconds' WHERE id = $1",
        [first.round_id],
      );
      expect(await start(a, quest)).toMatchObject({ attempts_left: null, replayed: false });
    });

    it("refuses a round after a pass, after a manual award, and for a quest of another type", async () => {
      const { event, quest, a } = await setup({ attempts: 3 });
      await finish(a, (await start(a, quest)).round_id);
      expect(await refusal(start(a, quest))).toBe("QD409:1");
      const awarded = await newQuest(event);
      await query(teamA(), "SELECT * FROM staff_award($1, $2, $3, NULL, 'Helped', $4, $5)", [
        event,
        a.enrollment,
        awarded,
        randomUUID(),
        randomUUID(),
      ]);
      expect(await refusal(start(a, awarded))).toBe("QD409:1");
      const [scan] = await owner<{ id: string }>(
        `INSERT INTO quest (event_id, category_id, type, title_en, points) VALUES ($1, $2, 'scan_qr', 'Scan', 5)
         RETURNING id`,
        [event, await newCategory(event)],
      );
      expect(await refusal(start(a, scan?.id ?? ""))).toBe("QT422:game");
    });

    it("refuses a banned account, an operator who may not play, a closed quest, a player banned from the event and a stranger", async () => {
      const { event, quest, a } = await setup();
      await owner("UPDATE player SET status = 'banned' WHERE id = $1", [a.player]);
      expect(await refusal(start(a, quest))).toBe("QC404");
      const operator = await member(event);
      await owner(
        "INSERT INTO staff_assignment (organizer_id, event_id, player_id, can_play) VALUES ($1, $2, $3, false)",
        [ids.orgA, event, operator.player],
      );
      expect(await refusal(start(operator, quest))).toBe("QP403");
      const banned = await member(event);
      await owner("UPDATE enrollment SET status = 'banned' WHERE id = $1", [banned.enrollment]);
      expect((await refusal(start(banned, quest))).startsWith("QC403")).toBe(true);
      const closed = await newQuest(event);
      await owner("UPDATE quest SET closes_at = now() - interval '1 minute' WHERE id = $1", [
        closed,
      ]);
      expect((await refusal(start(await member(event), closed))).startsWith("QN403")).toBe(true);
      const elsewhere = await newEvent("live", ids.orgB);
      expect(await refusal(start(await member(elsewhere, "code", ids.orgB), quest))).toBe("QC404");
      expect(await owner("SELECT 1 FROM game_round WHERE quest_id = $1", [quest])).toEqual([]);
    });

    it("refuses an issue while the event's switch is off, and still takes an issued round's result", async () => {
      const { event, quest, a } = await setup();
      const round = await start(a, quest);
      await owner(
        `UPDATE event SET config = jsonb_set(config, '{features}', coalesce(config -> 'features', '{}') || '{"miniGames": false}')
         WHERE id = $1`,
        [event],
      );
      expect(await refusal(start(await member(event), quest))).toBe("QF403");
      expect(await finish(a, round.round_id)).toMatchObject({ verdict: "passed", points: "40" });
    });

    it("keeps the level table equal to the shared one, all four games", async () => {
      for (const game of ["memory_match", "slide_puzzle", "catch", "tap_rush"] as const) {
        for (const level of ["easy", "medium", "hard"] as const) {
          const [row] = await owner<{ params: Row }>("SELECT game_level($1, $2) AS params", [
            game,
            level,
          ]);
          expect(row?.params, `${game} ${level}`).toEqual(LEVELS[game][level]);
        }
      }
    });
  });

  describe("results", () => {
    it("pays the points frozen at issue once on a pass, with the category bonus, keyed game:<round>", async () => {
      const event = await newEvent();
      const category = await newCategory(event, { bonus: 15 });
      const quest = await newQuest(event, {}, { category, points: 40 });
      const a = await member(event);
      const device = randomUUID();
      const round = await start(a, quest, randomUUID(), device);
      await owner("UPDATE quest SET points = 999 WHERE id = $1", [quest]);
      const key = randomUUID();
      const paid = await finish(a, round.round_id, { key, lastMs: 1000 });
      expect(paid).toMatchObject({
        verdict: "passed",
        points: "40",
        score: "55",
        replayed: false,
        result: PASS,
      });
      expect(await completions(a.enrollment)).toEqual([
        { method: "game", idempotency_key: `game:${round.round_id}`, device_id: device },
      ]);
      expect(await ledger(a.enrollment)).toEqual([
        { kind: "quest", score_delta: "40" },
        { kind: "bonus", score_delta: "15" },
      ]);
      expect(await finish(a, round.round_id, { key })).toMatchObject({
        verdict: "passed",
        replayed: true,
      });
      expect(await refusal(finish(a, round.round_id))).toBe("QG409:finished");
      expect(await completions(a.enrollment)).toHaveLength(1);
    });

    it("pays nothing for a short round and keeps its result", async () => {
      const { quest, a } = await setup({ attempts: 2 });
      const round = await start(a, quest);
      expect(await finish(a, round.round_id, { verdict: "short", result: SHORT })).toMatchObject({
        verdict: "short",
        completion_id: null,
        attempts_left: 1,
        result: SHORT,
      });
      expect(await completions(a.enrollment)).toEqual([]);
      expect(await roundOf(round.round_id)).toMatchObject({
        status: "short",
        result: SHORT,
        reason: null,
      });
      expect(
        await query(
          as(a.player),
          "SELECT used, attempts_left, last_verdict, last_result FROM member_game($1)",
          [quest],
        ),
      ).toEqual([{ used: 1, attempts_left: 1, last_verdict: "short", last_result: SHORT }]);
    });

    it("refuses an impossible round: no points, the attempt used, the flag raised and then extended", async () => {
      const { quest, a } = await setup({ attempts: 3 });
      const first = await start(a, quest);
      expect(
        await finish(a, first.round_id, { verdict: "refused", reason: "too_fast" }),
      ).toMatchObject({
        verdict: "refused",
        completion_id: null,
        attempts_left: 2,
        result: null,
      });
      expect(await flagOf(a)).toMatchObject({
        status: "open",
        evidence: {
          rounds: [
            {
              round: Number(first.round_id),
              game: "memory_match",
              level: "easy",
              reason: "too_fast",
            },
          ],
        },
      });
      const second = await start(a, quest);
      await finish(a, second.round_id, { verdict: "refused", reason: "claimed" });
      expect((await flagOf(a))?.evidence.rounds.map((entry) => entry["reason"])).toEqual([
        "too_fast",
        "claimed",
      ]);
      expect(await completions(a.enrollment)).toEqual([]);
      expect(
        await owner("SELECT count(*)::int AS n FROM flag WHERE enrollment_id = $1", [a.enrollment]),
      ).toEqual([{ n: 1 }]);
    });

    it("pays an unlikely pass and flags it", async () => {
      const { quest, a } = await setup();
      const round = await start(a, quest);
      expect(await finish(a, round.round_id, { unlikely: true })).toMatchObject({
        verdict: "passed",
        points: "40",
      });
      expect((await flagOf(a))?.evidence.rounds).toMatchObject([{ reason: "unlikely" }]);
      expect(await roundOf(round.round_id)).toMatchObject({ unlikely: true });
    });

    it("refuses as `clock` a round whose inputs span more time than the server saw, plus 3 seconds", async () => {
      const { quest, a } = await setup({ attempts: 2 });
      const fine = await start(a, quest);
      expect(
        await finish(a, fine.round_id, { verdict: "short", result: SHORT, lastMs: 2900 }),
      ).toMatchObject({
        verdict: "short",
      });
      const fast = await start(a, quest);
      expect(await finish(a, fast.round_id, { lastMs: 60_000 })).toMatchObject({
        verdict: "refused",
      });
      expect(await roundOf(fast.round_id)).toMatchObject({
        status: "refused",
        reason: "clock",
        result: null,
      });
      expect((await flagOf(a))?.evidence.rounds).toMatchObject([{ reason: "clock" }]);
      expect(await completions(a.enrollment)).toEqual([]);
    });

    it("answers `expired` past the window and writes nothing; the round counts and the sweep closes it", async () => {
      const { quest, a } = await setup({ attempts: 2 });
      const round = await start(a, quest);
      await pastDeadline(round.round_id);
      expect(await refusal(finish(a, round.round_id))).toBe("QG409:expired");
      expect(await roundOf(round.round_id)).toMatchObject({ status: "open", result_key: null });
      expect(await flagOf(a)).toBeUndefined();
      expect(
        await query(as(a.player), "SELECT used, attempts_left, open_round FROM member_game($1)", [
          quest,
        ]),
      ).toEqual([{ used: 1, attempts_left: 1, open_round: null }]);
      while ((await sweep()) !== null) {
        // drain every due round of this database
      }
      expect(await roundOf(round.round_id)).toMatchObject({ status: "expired" });
    });

    it("writes nothing for a player who can no longer play, and keeps the round open", async () => {
      const { quest, a } = await setup();
      const round = await start(a, quest);
      await owner("UPDATE quest SET closes_at = now() - interval '1 second' WHERE id = $1", [
        quest,
      ]);
      expect((await refusal(finish(a, round.round_id))).startsWith("QN403")).toBe(true);
      expect(await roundOf(round.round_id)).toMatchObject({ status: "open", result_key: null });
      expect(await flagOf(a)).toBeUndefined();
    });

    it("answers `done` and pays nothing for a pass after a manual award", async () => {
      const { event, quest, a } = await setup();
      const round = await start(a, quest);
      await query(teamA(), "SELECT * FROM staff_award($1, $2, $3, NULL, 'Helped', $4, $5)", [
        event,
        a.enrollment,
        quest,
        randomUUID(),
        randomUUID(),
      ]);
      expect(await finish(a, round.round_id)).toMatchObject({
        verdict: "done",
        completion_id: null,
      });
      expect(await completions(a.enrollment)).toHaveLength(1);
    });

    it("refuses another player's round as not found, and a key of another round", async () => {
      const { event, quest, a } = await setup({ attempts: 2 });
      const round = await start(a, quest);
      const b = await member(event);
      expect(await refusal(finish(b, round.round_id))).toBe("QC404");
      expect(
        await query(as(b.player), "SELECT * FROM game_round_for_replay($1)", [round.round_id]),
      ).toEqual([]);
      const key = randomUUID();
      await finish(a, round.round_id, { verdict: "short", result: SHORT, key });
      const next = await start(a, quest);
      expect(await refusal(finish(a, next.round_id, { key }))).toBe("QK422");
    });

    it("reads the caller's own frozen round for the replay", async () => {
      const { quest, a } = await setup({ game: "slide_puzzle", level: "hard" });
      const round = await start(a, quest);
      expect(
        await query(
          as(a.player),
          "SELECT game, level, seed, params, engine_version, status FROM game_round_for_replay($1)",
          [round.round_id],
        ),
      ).toEqual([
        {
          game: "slide_puzzle",
          level: "hard",
          seed: round.seed,
          params: LEVELS.slide_puzzle.hard,
          engine_version: 1,
          status: "open",
        },
      ]);
    });
  });

  describe("the last attempt, the sweep and leaving", () => {
    it("counts the quest done when the last attempt fails, pays the category bonus once and opens the next quest", async () => {
      const event = await newEvent();
      const category = await newCategory(event, { bonus: 20, order: "in_order" });
      const quest = await newQuest(event, { attempts: 1 }, { category, position: 0 });
      const after = await newQuest(event, {}, { category, position: 1 });
      const a = await member(event);
      expect(await refusal(start(a, after))).toBe("QN403:order_locked");
      await finish(a, (await start(a, quest)).round_id, { verdict: "short", result: SHORT });
      expect(await done(a, quest)).toBe(true);
      expect(await ledger(a.enrollment)).toEqual([]);
      await finish(a, (await start(a, after)).round_id);
      expect(await ledger(a.enrollment)).toEqual([
        { kind: "quest", score_delta: "40" },
        { kind: "bonus", score_delta: "20" },
      ]);
      const [listed] = await query<Row>(
        as(a.player),
        "SELECT done, game_left, game_passed FROM member_event_quests($1) WHERE quest_id = $2",
        [event, quest],
      );
      expect(listed).toEqual({ done: 1, game_left: 0, game_passed: false });
    });

    it("pays the category bonus when the failed last attempt completes the category", async () => {
      const event = await newEvent();
      const category = await newCategory(event, { bonus: 20 });
      const quest = await newQuest(event, { attempts: 1 }, { category });
      const a = await member(event);
      await finish(a, (await start(a, quest)).round_id, { verdict: "refused", reason: "illegal" });
      expect(await ledger(a.enrollment)).toEqual([{ kind: "bonus", score_delta: "20" }]);
    });

    it("counts a last open round done the moment its window ends, before the sweep, and the sweep pays the bonus", async () => {
      const event = await newEvent();
      const category = await newCategory(event, { bonus: 20 });
      const quest = await newQuest(event, { attempts: 1 }, { category });
      const a = await member(event);
      const round = await start(a, quest);
      expect(await done(a, quest)).toBe(false);
      await pastDeadline(round.round_id);
      expect(await done(a, quest)).toBe(true);
      expect(
        await query(as(a.player), "SELECT open_round, done FROM member_game($1)", [quest]),
      ).toEqual([{ open_round: null, done: true }]);
      while ((await sweep()) !== null) {
        // drain
      }
      expect(await roundOf(round.round_id)).toMatchObject({ status: "expired" });
      expect(await ledger(a.enrollment)).toEqual([{ kind: "bonus", score_delta: "20" }]);
      expect(await query(as(a.player), "SELECT close_one_due_round() AS outcome")).toEqual([
        { outcome: null },
      ]);
    });

    it("never counts unlimited attempts done", async () => {
      const { quest, a } = await setup({ attempts: null, cooldownMinutes: 1 });
      await finish(a, (await start(a, quest)).round_id, { verdict: "short", result: SHORT });
      expect(await done(a, quest)).toBe(false);
    });

    it("abandons the open round when the player leaves the event", async () => {
      const { quest, a } = await setup();
      const round = await start(a, quest);
      await owner("UPDATE enrollment SET status = 'left' WHERE id = $1", [a.enrollment]);
      expect(await roundOf(round.round_id)).toMatchObject({ status: "abandoned" });
      expect(await refusal(finish(a, round.round_id))).toBe("QG409:finished");
    });
  });

  describe("the rest of the engine knows game quests", () => {
    it("refuses a game quest through complete_quest, and the reserved `game:` key", async () => {
      const { event, quest, a } = await setup();
      expect(
        await refusal(
          query(as(a.player), "SELECT * FROM complete_quest($1, 'qr', 1, NULL, $2, NULL)", [
            quest,
            randomUUID(),
          ]),
        ),
      ).toBe("QV422:wrong_method");
      const [scan] = await owner<{ id: string }>(
        `INSERT INTO quest (event_id, category_id, type, title_en, points, type_config)
         VALUES ($1, $2, 'enter_code', 'Code', 5, '{"code": "ABCD"}') RETURNING id`,
        [event, await newCategory(event)],
      );
      expect(
        await refusal(
          query(
            as(a.player),
            "SELECT * FROM complete_quest($1, 'code', NULL, 'ABCD', 'game:1', NULL)",
            [scan?.id],
          ),
        ),
      ).toBe("QK422");
    });

    it("refuses a game config of the wrong shape and a repeat cap above 1", async () => {
      const event = await newEvent();
      const category = await newCategory(event);
      for (const config of [
        "{}",
        '{"game": "snake", "level": "easy", "attempts": 1, "cooldownMinutes": null}',
        '{"game": "tap_rush", "level": "expert", "attempts": 1, "cooldownMinutes": null}',
        '{"game": "memory_match", "level": "expert", "attempts": 1, "cooldownMinutes": null}',
        '{"game": "memory_match", "level": "easy", "attempts": 0, "cooldownMinutes": null}',
        '{"game": "memory_match", "level": "easy", "attempts": 11, "cooldownMinutes": null}',
        '{"game": "memory_match", "level": "easy", "attempts": 2, "cooldownMinutes": 5}',
        '{"game": "memory_match", "level": "easy", "attempts": null, "cooldownMinutes": null}',
        '{"game": "memory_match", "level": "easy", "attempts": null, "cooldownMinutes": 1441}',
        '{"game": "memory_match", "level": "easy", "attempts": 1.5, "cooldownMinutes": null}',
        '{"game": "memory_match", "level": "easy", "cooldownMinutes": null}',
      ]) {
        expect(
          await refusal(
            owner(
              `INSERT INTO quest (event_id, category_id, type, title_en, points, type_config)
               VALUES ($1, $2, 'game', 'G', 5, $3)`,
              [event, category, config],
            ),
          ),
          config,
        ).toBe("23514");
      }
      expect(
        await refusal(
          owner(
            `INSERT INTO quest (event_id, category_id, type, title_en, points, type_config, repeat_cap)
             VALUES ($1, $2, 'game', 'G', 5, $3, 2)`,
            [event, category, JSON.stringify(configOf({}))],
          ),
        ),
      ).toBe("23514");
    });

    it("locks a game's config once a round exists, before which it may change; its points stay editable", async () => {
      const { quest, a } = await setup();
      await owner(`UPDATE quest SET type_config = $2 WHERE id = $1`, [
        quest,
        JSON.stringify(configOf({ level: "hard" })),
      ]);
      await start(a, quest);
      for (const change of [
        { level: "medium" },
        { game: "slide_puzzle" },
        { attempts: 2 },
        { attempts: null, cooldownMinutes: 5 },
      ]) {
        expect(
          await refusal(
            owner("UPDATE quest SET type_config = $2 WHERE id = $1", [
              quest,
              JSON.stringify(configOf({ level: "hard", ...change })),
            ]),
          ),
          JSON.stringify(change),
        ).toBe("QL409");
      }
      await owner("UPDATE quest SET points = 70, title_en = 'Renamed' WHERE id = $1", [quest]);
      expect(await query(teamA(), "SELECT * FROM submitters_of($1)", [[quest]])).toEqual([
        { enrollment_id: a.enrollment },
      ]);
    });

    it("lists a mini-game case with its rounds, an unlikely one with its result, for the event's team", async () => {
      const { event, quest, a } = await setup({ attempts: 2 });
      const round = await start(a, quest);
      await finish(a, round.round_id, { verdict: "refused", reason: "late" });
      const lucky = await start(a, quest);
      const luckyResult = { ...PASS, lucky: 5 };
      await finish(a, lucky.round_id, { result: luckyResult, unlikely: true });
      const [listed] = await query<{ id: string; kind: string; scans: number }>(
        teamA(),
        "SELECT id, kind, scans FROM event_flags($1, true, NULL, 50)",
        [event],
      );
      expect(listed).toMatchObject({ kind: "minigame", scans: 2 });
      const [detail] = await query<{ evidence: Row[] }>(
        teamA(),
        "SELECT evidence FROM flag_detail($1, $2)",
        [event, listed?.id],
      );
      const teamB = { organizerId: ids.orgB, staffUserId: ownerB };
      expect(
        await refusal(query(teamB, "SELECT * FROM event_flags($1, true, NULL, 50)", [event])),
      ).toBe("AN404");
      expect(
        await refusal(query(teamB, "SELECT * FROM flag_detail($1, $2)", [event, listed?.id])),
      ).toBe("AN404");
      expect(detail?.evidence).toEqual([
        {
          at: expect.any(String),
          roundId: Number(round.round_id),
          game: "memory_match",
          level: "easy",
          reason: "late",
          verdict: "refused",
          result: null,
          questAr: null,
          questEn: "Play",
        },
        {
          at: expect.any(String),
          roundId: Number(lucky.round_id),
          game: "memory_match",
          level: "easy",
          reason: "unlikely",
          verdict: "passed",
          result: luckyResult,
          questAr: null,
          questEn: "Play",
        },
      ]);
    });

    it("deletes an erased account's rounds, and a rehearsal account's with the wipe, counted", async () => {
      const { quest, a } = await setup();
      await finish(a, (await start(a, quest)).round_id);
      await owner("SELECT erase_rows($1, $2, NULL)", [a.player, [a.enrollment]]);
      expect(
        await owner("SELECT 1 FROM game_round WHERE enrollment_id = $1", [a.enrollment]),
      ).toEqual([]);

      const event = await newEvent("draft");
      await owner(
        "INSERT INTO event_rehearsal (event_id, organizer_id, code) VALUES ($1, $2, 'GAME-REHR')",
        [event, ids.orgA],
      );
      const rehearsed = await newQuest(event);
      const tester = await member(event, "rehearsal");
      await finish(tester, (await start(tester, rehearsed)).round_id);
      const [wiped] = await owner<{ counts: Row }>(
        "SELECT wipe_rehearsal($1, 'go_live', $2) AS counts",
        [event, randomUUID()],
      );
      expect(wiped?.counts).toMatchObject({ games: 1, completions: 1 });
      expect(
        await owner("SELECT 1 FROM game_round WHERE enrollment_id = $1", [tester.enrollment]),
      ).toEqual([]);
    });
  });

  describe("races (two connections, 50 rounds each)", () => {
    const rounds = 50;

    it("answers the same result sent twice at once with one verdict and one replay", async () => {
      const { event } = await setup();
      for (let index = 0; index < rounds; index += 1) {
        const quest = await newQuest(event);
        const a = await member(event);
        const round = await start(a, quest);
        const key = randomUUID();
        const answers = await Promise.all([
          finish(a, round.round_id, { key }),
          finish(a, round.round_id, { key }),
        ]);
        expect(answers.map((answer) => answer.replayed).toSorted()).toEqual([false, true]);
        expect(await completions(a.enrollment)).toHaveLength(1);
      }
    });

    it("pays one of two results of one round under two keys and answers the other `finished`", async () => {
      const { event } = await setup();
      for (let index = 0; index < rounds; index += 1) {
        const quest = await newQuest(event);
        const a = await member(event);
        const round = await start(a, quest);
        const outcomes = await Promise.all([
          refusal(finish(a, round.round_id)),
          refusal(finish(a, round.round_id)),
        ]);
        expect(outcomes.toSorted()).toEqual(["QG409:finished", "none"]);
        expect(await completions(a.enrollment)).toHaveLength(1);
      }
    });

    it("lets a result and the sweep closing the round at its deadline cross without a double close", async () => {
      const { event } = await setup();
      for (let index = 0; index < rounds; index += 1) {
        const quest = await newQuest(event);
        const a = await member(event);
        const round = await start(a, quest);
        await owner(
          "UPDATE game_round SET deadline_at = now() + interval '30 milliseconds' WHERE id = $1",
          [round.round_id],
        );
        const [result] = await Promise.all([refusal(finish(a, round.round_id)), sweep()]);
        const row = await roundOf(round.round_id);
        if (result === "none") {
          expect(row["status"]).toBe("passed");
        } else {
          expect(result).toBe("QG409:expired");
        }
        expect(await completions(a.enrollment)).toHaveLength(result === "none" ? 1 : 0);
      }
    });

    it("lets a result and the player's ban cross: paid before the ban, or the round abandoned", async () => {
      const { event } = await setup();
      for (let index = 0; index < rounds; index += 1) {
        const quest = await newQuest(event);
        const a = await member(event);
        const round = await start(a, quest);
        const [result] = await Promise.all([
          refusal(finish(a, round.round_id)),
          owner("UPDATE enrollment SET status = 'banned' WHERE id = $1", [a.enrollment]),
        ]);
        const status = (await roundOf(round.round_id))["status"];
        expect(
          result === "none" ? status === "passed" : status === "abandoned",
          `${result} ${String(status)}`,
        ).toBe(true);
      }
    });

    it("pays a pass beside a QR scan on the same phone, both counted, without a deadlock", async () => {
      const { event } = await setup();
      const device = randomUUID();
      for (let index = 0; index < rounds; index += 1) {
        const quest = await newQuest(event);
        const [scan] = await owner<{ id: string; qr_version: number }>(
          `INSERT INTO quest (event_id, category_id, type, title_en, points) VALUES ($1, $2, 'scan_qr', 'Scan', 5)
           RETURNING id, qr_version`,
          [event, await newCategory(event)],
        );
        const a = await member(event);
        const round = await start(a, quest, randomUUID(), device);
        await Promise.all([
          finish(a, round.round_id),
          query(as(a.player), "SELECT * FROM complete_quest($1, 'qr', $2, NULL, $3, $4)", [
            scan?.id,
            scan?.qr_version,
            randomUUID(),
            device,
          ]),
        ]);
        expect(await completions(a.enrollment)).toHaveLength(2);
      }
    });

    it("pays once for a pass beside a manual award of the same quest", async () => {
      const { event } = await setup();
      for (let index = 0; index < rounds; index += 1) {
        const quest = await newQuest(event);
        const a = await member(event);
        const round = await start(a, quest);
        await Promise.all([
          refusal(finish(a, round.round_id)),
          refusal(
            query(teamA(), "SELECT * FROM staff_award($1, $2, $3, NULL, 'Helped', $4, $5)", [
              event,
              a.enrollment,
              quest,
              randomUUID(),
              randomUUID(),
            ]),
          ),
        ]);
        expect(await completions(a.enrollment)).toHaveLength(1);
      }
    });
  });

  describe("a round gone or closed while a caller waited on its locks", () => {
    it("lets two sweeps cross over one due round: one closes it, the other closes nothing", async () => {
      while ((await sweep()) !== null) {
        // drain every due round of this database
      }
      const { quest, a } = await setup();
      const round = await start(a, quest);
      await pastDeadline(round.round_id);
      const outcomes = await Promise.all([sweep(), sweep()]);
      expect(outcomes.map((outcome) => outcome ?? "none").toSorted()).toEqual(["expired", "none"]);
      expect(await roundOf(round.round_id)).toMatchObject({ status: "expired" });
    });

    it("closes nothing, and says so, when the rehearsal wipe deletes the due round the sweep waits on", async () => {
      while ((await sweep()) !== null) {
        // drain every due round of this database
      }
      const event = await newEvent("draft");
      await owner(
        "INSERT INTO event_rehearsal (event_id, organizer_id, code) VALUES ($1, $2, 'GAME-SWEP')",
        [event, ids.orgA],
      );
      const tester = await member(event, "rehearsal");
      const round = await start(tester, await newQuest(event));
      await pastDeadline(round.round_id);
      await db.owner.query("BEGIN");
      await db.owner.query("SELECT wipe_rehearsal($1, 'go_live', $2)", [event, randomUUID()]);
      const waiting = sweep();
      await new Promise((resolve) => setTimeout(resolve, 300));
      await db.owner.query("COMMIT");
      expect(await waiting).toBeNull();
    });

    it("answers a result waiting while the rehearsal wipe deletes its round as not found", async () => {
      const event = await newEvent("draft");
      await owner(
        "INSERT INTO event_rehearsal (event_id, organizer_id, code) VALUES ($1, $2, 'GAME-WAKE')",
        [event, ids.orgA],
      );
      const quest = await newQuest(event);
      const tester = await member(event, "rehearsal");
      const round = await start(tester, quest);
      await db.owner.query("BEGIN");
      await db.owner.query("SELECT wipe_rehearsal($1, 'go_live', $2)", [event, randomUUID()]);
      const waiting = refusal(finish(tester, round.round_id));
      await new Promise((resolve) => setTimeout(resolve, 300));
      await db.owner.query("COMMIT");
      expect(await waiting).toBe("QC404");
      expect(await owner("SELECT 1 FROM game_round WHERE id = $1", [round.round_id])).toEqual([]);
    });
  });

  describe("closed doors", () => {
    it("lets the API role run only the five doors", async () => {
      const runnable = await owner<{ proname: string }>(
        `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND (p.proname LIKE '%game%' OR p.proname LIKE '%round%')
           AND has_function_privilege('questify_app', p.oid, 'EXECUTE')
         ORDER BY 1`,
      );
      expect(runnable.map((row) => row.proname)).toEqual([
        "close_one_due_round",
        "finish_game_round",
        "game_round_for_replay",
        "member_game",
        "start_game_round",
      ]);
    });

    it("keeps the table and the helpers away from the API role", async () => {
      for (const sql of [
        "SELECT * FROM game_round",
        "SELECT games_on(gen_random_uuid())",
        "SELECT game_level('memory_match', 'easy')",
        "SELECT * FROM game_attempts(gen_random_uuid(), NULL::quest)",
        "SELECT game_left(gen_random_uuid(), NULL::quest)",
        "SELECT game_spent(gen_random_uuid(), NULL::quest)",
        "SELECT game_payable(NULL::enrollment)",
        "SELECT game_last_attempt(NULL::enrollment, NULL::quest)",
        "SELECT raise_game_flag(NULL::game_round, 'x')",
        "SELECT * FROM game_answer(NULL::game_round, false)",
        "SELECT game_issue_replay(gen_random_uuid(), 'k', gen_random_uuid())",
        "SELECT game_issue_check(NULL::enrollment, NULL::quest)",
      ]) {
        await expect(db.app.query(sql), sql).rejects.toThrow(/permission denied/);
      }
    });
  });
});
