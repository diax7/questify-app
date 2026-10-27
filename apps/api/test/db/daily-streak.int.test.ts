import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { questifyFixture, type QuestifyFixture } from "#test/support/questify";
import { TEST_DATABASE_URL } from "#test/support/test-db";

type Streak = Readonly<{
  days: number;
  today: boolean;
  next: Readonly<{ days: number; xp: number }> | null;
}>;
type SyncAnswer = Readonly<{
  levelUp: Readonly<{ level: number; items: readonly { id: string }[] }> | null;
  gems: Readonly<{ earned: number; balance: number }>;
  dailyStreak: (Streak & Readonly<{ rewards: readonly { days: number; xp: number }[] }>) | null;
}>;

const refusal = async (work: Promise<unknown>): Promise<string> =>
  work.then(
    () => "none",
    (error: { code?: string }) => error.code ?? "unknown",
  );

const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, n) => from + n);

/**
 * The Questify daily streak in the database (T-405, migration 0068, ADR-297, ADR-298, FR-419 to FR-421): one row per
 * player and Questify day (04:00 to 04:00 Riyadh) from any event's completion while the platform switch is on, the
 * length read from the run of rows, the XP milestones paid once ever by questify_sync, the pre-check that takes no lock,
 * no points and no gems from a milestone, and the XP invariant. Earlier days are written as rows, since a test cannot
 * move the clock.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("the Questify daily streak (database)", () => {
  let f: QuestifyFixture;

  beforeAll(async () => {
    f = await questifyFixture();
  });
  afterAll(async () => {
    await f.close();
  });

  const owner = <T extends Record<string, unknown>>(sql: string, values: unknown[] = []) =>
    f.owner<T>(sql, values);
  const live = () => f.newEvent({ phase: "live" });
  /** A player with one completion today in a new live event (a quest pays 100 XP). */
  const playedToday = async () => {
    const player = await f.newPlayer();
    await f.play(await live(), player);
    return player;
  };
  /** Questify days before today, as offsets (1 is yesterday). */
  const seed = (player: string, offsets: number[]) =>
    owner(
      `INSERT INTO questify_streak_day (player_id, day)
       SELECT $1, questify_day(now()) - o FROM unnest($2::int[]) o`,
      [player, offsets],
    );
  const daysOf = (player: string) =>
    owner<{ day: string }>(
      "SELECT day::text AS day FROM questify_streak_day WHERE player_id = $1 ORDER BY day",
      [player],
    );
  const own = async (player: string) =>
    (await f.asPlayer<{ s: Streak | null }>(player, "SELECT own_daily_streak() AS s"))[0]?.s;
  const sync = async (player: string) =>
    (await f.asPlayer<{ r: SyncAnswer }>(player, "SELECT questify_sync() AS r"))[0]?.r;
  const xpOf = async (player: string) =>
    Number(
      (await owner<{ xp: string }>("SELECT xp FROM player_xp WHERE player_id = $1", [player]))[0]
        ?.xp,
    );
  const switchTo = (enabled: boolean) =>
    owner(
      `INSERT INTO platform_setting (key, value) VALUES ('features', jsonb_build_object('dailyStreak',
         jsonb_build_object('enabled', $1::boolean)))
       ON CONFLICT (key) DO UPDATE SET value = platform_setting.value || excluded.value`,
      [enabled],
    );

  it("one Questify day for everyone, 04:00 to 04:00 Riyadh time", async () => {
    const [row] = await owner<{ before: string; at: string; late: string }>(
      `SELECT questify_day('2026-10-27 00:59:59.999999+00')::text AS before,
              questify_day('2026-10-27 01:00:00+00')::text AS at,
              questify_day('2026-10-27 23:59:59+03')::text AS late`,
    );
    expect(row).toEqual({ before: "2026-10-26", at: "2026-10-27", late: "2026-10-27" });
  });

  it("any event's completion counts the day once: two events, one day, one row; repeats add nothing", async () => {
    const player = await f.newPlayer();
    await f.play(await live(), player, 2);
    await f.play(await live(), player);
    // An ended event's late entry is play too.
    await f.play(await f.newEvent({ phase: "ended" }), player);
    const [today] = await owner<{ d: string }>("SELECT questify_day(now())::text AS d");
    expect(await daysOf(player)).toEqual([{ day: today?.d }]);
    expect(await own(player)).toEqual({ days: 1, today: true, next: { days: 3, xp: 50 } });
  });

  it("a rehearsal account's completion does not count", async () => {
    const player = await f.newPlayer();
    const event = await f.newEvent({ phase: "scheduled" });
    const enrollment = await f.join(event, player, "rehearsal");
    await f.earn(event, enrollment);
    expect(await daysOf(player)).toEqual([]);
  });

  it("reads the run ending today, else ending yesterday, else 0", async () => {
    const cases: [number[], boolean, number][] = [
      [[1, 2], true, 3],
      [[2, 3], true, 1],
      [[1, 2], false, 2],
      [[2, 3, 4], false, 0],
      [[], false, 0],
    ];
    for (const [earlier, today, expected] of cases) {
      const player = today ? await playedToday() : await f.newPlayer();
      await seed(player, earlier);
      expect((await own(player))?.days, JSON.stringify([earlier, today])).toBe(expected);
      expect((await own(player))?.today).toBe(today);
    }
  });

  it("pays the milestones at the sync, each once ever, and the next one shown is the first unpaid above the run", async () => {
    const player = await playedToday();
    await seed(player, range(1, 6));
    expect(await own(player)).toMatchObject({ days: 7, next: { days: 14, xp: 150 } });
    const first = await sync(player);
    expect(first?.dailyStreak).toEqual({
      days: 7,
      today: true,
      next: { days: 14, xp: 150 },
      rewards: [
        { days: 3, xp: 50 },
        { days: 7, xp: 100 },
      ],
    });
    expect(await xpOf(player)).toBe(250);
    expect((await sync(player))?.dailyStreak?.rewards).toEqual([]);
    // A player paid at 3 in an earlier run who reaches 3 again is paid nothing: each milestone is paid once ever.
    const again = await playedToday();
    await owner("INSERT INTO questify_streak_reward (player_id, days, xp) VALUES ($1, 3, 50)", [
      again,
    ]);
    await seed(again, [1, 2]);
    expect((await sync(again))?.dailyStreak).toMatchObject({ days: 3, rewards: [] });
    expect(await xpOf(again)).toBe(100);
    expect(
      await owner<{ days: number; xp: number }>(
        "SELECT days, xp FROM questify_streak_reward WHERE player_id = $1 ORDER BY days",
        [player],
      ),
    ).toEqual([
      { days: 3, xp: 50 },
      { days: 7, xp: 100 },
    ]);
  });

  it("streak XP raises the level, grants the level item and the level's gems through the level source", async () => {
    const player = await playedToday();
    await seed(player, range(1, 6));
    const answer = await sync(player);
    expect(answer?.levelUp).toMatchObject({ level: 2, items: [{ id: "level-2" }] });
    const gems = await owner<{ source: string; source_level: number | null; delta: number }>(
      "SELECT source, source_level, delta FROM gem_entry WHERE player_id = $1 ORDER BY id",
      [player],
    );
    // The level's gems through the level source; any other row is an achievement tier of the play itself.
    expect(gems.filter((row) => row.source !== "achievement")).toEqual([
      { source: "level", source_level: 2, delta: 20 },
    ]);
    expect(answer?.gems.earned).toBe(gems.reduce((sum, row) => sum + row.delta, 0));
    expect(
      await owner<{ source: string }>(
        `SELECT x.source FROM level_reached r JOIN xp_entry x ON x.id = r.xp_entry_id
         WHERE r.player_id = $1 AND r.level = 2`,
        [player],
      ),
    ).toEqual([{ source: "streak" }]);
  });

  it("a milestone pays XP only: no points and no gems of its own (FR-421, Q-263)", async () => {
    const player = await playedToday();
    await seed(player, [1, 2]);
    const entries = async () =>
      Number(
        (
          await owner<{ n: string }>(
            `SELECT count(*) AS n FROM ledger_entry l JOIN enrollment n ON n.id = l.enrollment_id
             WHERE n.player_id = $1`,
            [player],
          )
        )[0]?.n,
      );
    const before = await entries();
    expect((await sync(player))?.dailyStreak?.rewards).toEqual([{ days: 3, xp: 50 }]);
    expect(await entries()).toBe(before);
    expect(
      await owner("SELECT 1 FROM gem_entry WHERE player_id = $1 AND source <> 'achievement'", [
        player,
      ]),
    ).toEqual([]);
    const writers = await owner<{ name: string }>(
      `SELECT p.proname AS name FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.prosrc ~* 'insert\\s+into\\s+(public\\.)?gem_entry' ORDER BY 1`,
    );
    expect(writers.map((row) => row.name)).toEqual(["gem_buy", "questify_sync"]);
    const [check] = await owner<{ def: string }>(
      "SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'gem_entry_source_check'",
    );
    expect(check?.def).not.toMatch(/streak/);
    expect(
      await refusal(
        owner("INSERT INTO gem_entry (player_id, delta, source) VALUES ($1, 5, 'streak')", [
          player,
        ]),
      ),
    ).toBe("23514");
  });

  it("two syncs crossing pay each milestone once", async () => {
    const player = await playedToday();
    await seed(player, [1, 2]);
    const call = { context: { playerId: player }, sql: "SELECT questify_sync() AS r" };
    const outcome = await f.crossed(call, call);
    expect(outcome.waited).toBe(true);
    const rewards = [outcome.first, outcome.second].map(
      (one) => (one as { r: SyncAnswer }).r.dailyStreak?.rewards,
    );
    expect(rewards).toEqual([[{ days: 3, xp: 50 }], []]);
    expect(await xpOf(player)).toBe(150);
  });

  it("with nothing due, the sync takes no row lock (player_xp held elsewhere)", async () => {
    const player = await playedToday();
    await sync(player);
    // The owner's own connection holds the row; the sync runs on the API's pool.
    const held = f.db.owner;
    await held.query("BEGIN");
    try {
      await held.query("SELECT 1 FROM player_xp WHERE player_id = $1 FOR UPDATE", [player]);
      const answer = await Promise.race([
        sync(player),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
      ]);
      expect(answer?.dailyStreak).toEqual({
        days: 1,
        today: true,
        next: { days: 3, xp: 50 },
        rewards: [],
      });
    } finally {
      await held.query("ROLLBACK");
    }
  });

  it("the platform switch off: no day counted, nothing shown and nothing paid; back on, the streak restarts", async () => {
    const player = await f.newPlayer();
    await seed(player, [1, 2]);
    await switchTo(false);
    try {
      await f.play(await live(), player);
      expect(await daysOf(player)).toHaveLength(2);
      expect(await own(player)).toBeNull();
      const answer = await sync(player);
      expect(answer?.dailyStreak).toBeNull();
      expect(
        await owner("SELECT 1 FROM questify_streak_reward WHERE player_id = $1", [player]),
      ).toEqual([]);
    } finally {
      await switchTo(true);
    }
    // The day played while off was never counted: today's play starts a new run after the gap.
    const back = await f.newPlayer();
    await seed(back, [2, 3]);
    await f.play(await live(), back);
    expect((await own(back))?.days).toBe(1);
    expect(await own(player)).toMatchObject({ days: 2, today: false });
  });

  it("is the owner's alone: a staff seat and an unknown player read nothing", async () => {
    expect(await f.run(f.team(), "SELECT own_daily_streak() AS s")).toEqual([{ s: null }]);
    expect(await f.run({ playerId: randomUUID() }, "SELECT own_daily_streak() AS s")).toEqual([
      { s: null },
    ]);
  });

  it("refuses UPDATE, DELETE and TRUNCATE on the daily rows, the milestones and the rewards", async () => {
    const player = await playedToday();
    await seed(player, [1, 2]);
    await sync(player);
    for (const sql of [
      "UPDATE questify_streak_day SET day = day - 1 WHERE player_id = $1",
      "DELETE FROM questify_streak_day WHERE player_id = $1",
      "UPDATE questify_streak_reward SET xp = 1 WHERE player_id = $1",
      "DELETE FROM questify_streak_reward WHERE player_id = $1",
    ]) {
      expect(await refusal(owner(sql, [player])), sql).toBe("42501");
    }
    for (const sql of [
      "UPDATE questify_streak_milestone SET xp = 1",
      "DELETE FROM questify_streak_milestone WHERE days = 365",
      "TRUNCATE questify_streak_day",
    ]) {
      expect(await refusal(owner(sql)), sql).toBe("42501");
    }
    // The referenced tables refuse TRUNCATE by the same always-enabled trigger (a bare TRUNCATE stops at the keys).
    expect(
      await owner<{ table: string }>(
        `SELECT c.relname AS table FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_proc p ON p.oid = t.tgfoid
         WHERE p.proname = 'streak_append_only' AND t.tgenabled = 'A' AND (t.tgtype & 32) <> 0
         ORDER BY 1`,
      ),
    ).toEqual([
      { table: "event_streak_day" },
      { table: "questify_streak_day" },
      { table: "questify_streak_milestone" },
      { table: "questify_streak_reward" },
    ]);
    expect(
      await owner<{ days: number; xp: number }>(
        "SELECT days, xp FROM questify_streak_milestone ORDER BY days",
      ),
    ).toEqual([
      { days: 3, xp: 50 },
      { days: 7, xp: 100 },
      { days: 14, xp: 150 },
      { days: 30, xp: 250 },
      { days: 60, xp: 300 },
      { days: 100, xp: 400 },
      { days: 200, xp: 500 },
      { days: 365, xp: 750 },
    ]);
  });

  it("the XP row of a milestone has its own shape and names a reward of the same player", async () => {
    const player = await playedToday();
    const other = await playedToday();
    await seed(player, [1, 2]);
    await sync(player);
    const [paid] = await owner<{ id: string }>(
      "SELECT id FROM questify_streak_reward WHERE player_id = $1",
      [player],
    );
    // A reward with no XP row yet, as an owner could write one.
    const [spare] = await owner<{ id: string }>(
      "INSERT INTO questify_streak_reward (player_id, days, xp) VALUES ($1, 7, 100) RETURNING id",
      [player],
    );
    const forge = (who: string, reward: string | undefined, fields: string, values: string) =>
      refusal(
        owner(`INSERT INTO xp_entry (player_id, delta, source, ${fields}) VALUES ($1, ${values})`, [
          who,
          reward,
        ]),
      );
    expect(await forge(player, paid?.id, "streak_reward_id", "50, 'streak', $2")).toBe("23505");
    expect(await forge(other, spare?.id, "streak_reward_id", "100, 'streak', $2")).toBe("23503");
    expect(await forge(player, spare?.id, "streak_reward_id", "-100, 'streak', $2")).toBe("23514");
    expect(
      await forge(
        player,
        spare?.id,
        "streak_reward_id, quest_id",
        "100, 'streak', $2, gen_random_uuid()",
      ),
    ).toBe("23514");
  });

  it("keeps the XP invariant", async () => {
    expect(
      await owner(
        `SELECT x.player_id FROM player_xp x
         WHERE x.xp <> (SELECT coalesce(sum(e.delta), 0) FROM xp_entry e WHERE e.player_id = x.player_id)`,
      ),
    ).toEqual([]);
  });
});
