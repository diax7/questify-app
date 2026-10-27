import { randomUUID } from "node:crypto";
import type { PoolClient, QueryResultRow } from "pg";
import type { RequestContext } from "#src/db/context";
import { questifyFixture } from "#test/support/questify";

export type Bilingual = Readonly<{ ar: string; en: string }>;
export type Statement = Readonly<{ context: RequestContext; sql: string; values?: unknown[] }>;

/** A question's fields as the console sends them. */
export const questionFields = (n: number, options = 3, answer = 2) => ({
  prompt: { ar: `سؤال ${n}`, en: `Question ${n}` },
  options: Array.from({ length: options }, (_, i) => ({
    ar: `خيار ${i + 1}`,
    en: `Option ${i + 1}`,
  })),
  answer,
});

/** The failure's SQLSTATE and DETAIL, or "none". */
export const refusal = async (work: Promise<unknown>): Promise<string> =>
  work.then(
    () => "none",
    (error: { code?: string; detail?: string }) =>
      error.detail === undefined || error.detail === null
        ? (error.code ?? "unknown")
        : `${error.code}:${error.detail}`,
  );

const settingsOf = (context: RequestContext): [string, string][] => [
  ["app.organizer_id", context.organizerId ?? ""],
  ["app.player_id", context.playerId ?? ""],
  ["app.staff_user_id", context.staffUserId ?? ""],
  ["app.is_admin", context.isAdmin === true ? "on" : ""],
];

/** Opens a transaction on `client` in the seat's request context. */
const begin = async (client: PoolClient, context: RequestContext) => {
  await client.query("BEGIN");
  for (const [key, value] of settingsOf(context)) {
    await client.query("SELECT set_config($1, $2, true)", [key, value]);
  }
};
/** A statement run in a player's seat. */
const asPlayerStatement = (player: string, sql: string, values: unknown[]): Statement => ({
  context: { playerId: player },
  sql,
  values,
});

/**
 * Fixtures for T-406's database suites. Tests cannot move the clock, so this database's `questify_day` (the one
 * boundary every daily read and write uses, by `now()` or `clock_timestamp()`) is replaced by one that adds a shift
 * read from `test_clock`: `goTo(day)` makes that day today for every connection at once. Content can only be set for
 * a future period, so a test sets it while the clock stands before the day, then moves the clock onto it.
 */
export async function dailyFixture() {
  const f = await questifyFixture();
  await f.owner("CREATE TABLE test_clock (shift interval NOT NULL)");
  await f.owner("INSERT INTO test_clock (shift) VALUES ('0 days')");
  await f.owner("GRANT SELECT ON test_clock TO PUBLIC");
  await f.owner(
    `CREATE OR REPLACE FUNCTION questify_day(at timestamptz) RETURNS date
       LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
       SELECT (((at + (SELECT c.shift FROM test_clock c)) AT TIME ZONE 'Asia/Riyadh') - interval '4 hours')::date
     $$`,
  );
  const [staff] = await f.owner<{ id: string }>(
    "INSERT INTO staff_user (email, password_hash, platform_role) VALUES ('daily@questify.test', 'h', 'admin') RETURNING id",
  );
  const admin = staff?.id ?? "";
  const seat: RequestContext = { isAdmin: true, staffUserId: admin };

  const today = async (): Promise<string> =>
    (await f.owner<{ d: string }>("SELECT questify_day(now())::text AS d"))[0]?.d ?? "";
  /** Makes `day` today (Riyadh's Questify day) for every connection. */
  const goTo = (day: string) =>
    f.owner(
      `UPDATE test_clock SET shift = make_interval(days => $1::date
         - (((now() AT TIME ZONE 'Asia/Riyadh') - interval '4 hours')::date))`,
      [day],
    );
  const plus = async (day: string, days: number): Promise<string> =>
    (await f.owner<{ d: string }>("SELECT ($1::date + $2::int)::text AS d", [day, days]))[0]?.d ??
    "";
  let cursor = "";
  /**
   * A Sunday no earlier test used, with the clock moved to the day before it (so content for it is still future).
   * Under the weekly cadence it starts a period.
   */
  /** The later of today and the first day no test used yet. */
  const unused = async (): Promise<string> => {
    const now = await today();
    return cursor === "" || cursor < now ? now : cursor;
  };
  const freshSunday = async (): Promise<string> => {
    const from = await unused();
    const [row] = await f.owner<{ d: string }>(
      "SELECT ($1::date + 14 - extract(dow FROM $1::date)::int)::text AS d",
      [from],
    );
    const sunday = row?.d ?? "";
    cursor = await plus(sunday, 7);
    await goTo(await plus(sunday, -1));
    return sunday;
  };
  /** A fresh day with the clock on the day before it (the daily cadence: any day starts a period). */
  const freshDay = async (): Promise<string> => {
    const from = await unused();
    const day = await plus(from, 3);
    cursor = await plus(day, 3);
    await goTo(await plus(day, -1));
    return day;
  };

  const door = async <T>(sql: string, values: unknown[] = []): Promise<T> =>
    (await f.run<{ r: T }>(seat, sql, values))[0]?.r as T;
  const call = async <T>(player: string, sql: string, values: unknown[] = []): Promise<T> =>
    (await f.asPlayer<{ r: T }>(player, sql, values))[0]?.r as T;

  const saveQuestion = (fields: object = questionFields(1), target: string | null = null) =>
    door<{ id: string; answer: number }>("SELECT daily_question_save($1, $2::jsonb, $3) AS r", [
      target,
      JSON.stringify(fields),
      randomUUID(),
    ]);
  const questions = async (n = 3, answer = 2): Promise<string[]> => {
    const made: string[] = [];
    for (let i = 0; i < n; i += 1)
      made.push((await saveQuestion(questionFields(i + 1, 3, answer))).id);
    return made;
  };
  const setChallenge = (day: string, picked: string[], sponsor: Bilingual | null = null) =>
    door<{ id: number; startsOn: string; questions: string[] }>(
      "SELECT daily_challenge_set($1, $2::uuid[], $3::jsonb, $4) AS r",
      [day, picked, sponsor === null ? null : JSON.stringify(sponsor), randomUUID()],
    );
  const setWord = (language: "ar" | "en", day: string, word: string) =>
    door<{ id: number; word: string }>("SELECT daily_word_set($1, $2, $3, $4) AS r", [
      language,
      day,
      word,
      randomUUID(),
    ]);
  const listWords = (language: "ar" | "en", adds: string[], removes: string[] = []) =>
    door<{ added: number; removed: number; refused: string[]; total: number }>(
      "SELECT word_list_change($1, $2::text[], $3::text[], $4) AS r",
      [language, adds, removes, randomUUID()],
    );
  const setCadence = (kind: "challenge" | "word", cadence: "daily" | "weekly") =>
    door<Record<string, unknown>>("SELECT daily_cadence_set($1, $2, $3) AS r", [
      kind,
      cadence,
      randomUUID(),
    ]);
  /** A challenge of three new questions (the right option is 2) on a fresh Sunday, made today. */
  const challengeToday = async (sponsor: Bilingual | null = null) => {
    const day = await freshSunday();
    const picked = await questions();
    const challenge = await setChallenge(day, picked, sponsor);
    await goTo(day);
    return { day, picked, challenge };
  };

  const answer = (
    player: string,
    challenge: number,
    question: string,
    pos: number,
    chosen: number,
  ) =>
    call<Record<string, unknown>>(player, "SELECT daily_answer_submit($1, $2, $3, $4) AS r", [
      challenge,
      question,
      pos,
      chosen,
    ]);
  const guess = (player: string, word: number, attempt: number, text: string) =>
    call<Record<string, unknown>>(player, "SELECT daily_guess_submit($1, $2, $3) AS r", [
      word,
      attempt,
      text,
    ]);
  const own = (player: string) =>
    call<{
      challenge: Record<string, unknown> | null;
      word: Record<string, unknown> | null;
    } | null>(player, "SELECT own_daily() AS r");
  const xpOf = async (player: string) =>
    Number(
      (await f.owner<{ xp: string }>("SELECT xp FROM player_xp WHERE player_id = $1", [player]))[0]
        ?.xp,
    );
  /** `player_xp.xp` equals the sum of the player's XP entries. */
  const xpHolds = async (player: string) => {
    const [row] = await f.owner<{ ok: boolean }>(
      `SELECT x.xp = coalesce((SELECT sum(e.delta) FROM xp_entry e WHERE e.player_id = x.player_id), 0) AS ok
       FROM player_xp x WHERE x.player_id = $1`,
      [player],
    );
    return row?.ok === true;
  };
  const switchFeature = (name: string, enabled: boolean) =>
    f.owner(
      `INSERT INTO platform_setting (key, value)
       VALUES ('features', jsonb_build_object($1::text, jsonb_build_object('enabled', $2::boolean)))
       ON CONFLICT (key) DO UPDATE SET value = platform_setting.value || excluded.value`,
      [name, enabled],
    );
  const xpSetting = (fields: Record<string, unknown>) =>
    f.owner("UPDATE platform_setting SET value = value || $1::jsonb WHERE key = 'xp'", [
      JSON.stringify(fields),
    ]);
  const streakDays = async (player: string) =>
    (
      await f.owner<{ day: string }>(
        "SELECT day::text AS day FROM questify_streak_day WHERE player_id = $1 ORDER BY day",
        [player],
      )
    ).map((row) => row.day);

  /**
   * Runs `first` in a transaction held open, runs `hooks.before`, starts `second` on another connection, waits until it
   * blocks on a lock (up to 2 s), runs `hooks.between` (say, moving the clock past 04:00), then commits the first and
   * awaits the second.
   */
  const held = async (
    first: Statement,
    second: Statement,
    hooks: Readonly<{ before?: () => Promise<unknown>; between?: () => Promise<unknown> }> = {},
  ): Promise<{ first: unknown; second: unknown; waited: boolean }> => {
    const a = await f.pool.connect();
    const b = await f.pool.connect();
    let pending: Promise<unknown> | undefined;
    try {
      await begin(a, first.context);
      const firstResult = (await a.query(first.sql, first.values ?? [])).rows[0];
      const pid = (await b.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
      await hooks.before?.();
      pending = (async () => {
        await begin(b, second.context);
        try {
          const result = (await b.query(second.sql, second.values ?? [])).rows[0];
          await b.query("COMMIT");
          return result;
        } catch (error) {
          await b.query("ROLLBACK");
          return error;
        }
      })();
      let waited = false;
      for (let attempt = 0; attempt < 200 && !waited; attempt += 1) {
        const blocked = await f.owner(
          "SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND wait_event_type = 'Lock'",
          [pid],
        );
        waited = blocked.length === 1;
        if (!waited) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await hooks.between?.();
      await a.query("COMMIT");
      return { first: firstResult, second: await pending, waited };
    } finally {
      await a.query("ROLLBACK");
      await pending;
      a.release();
      b.release();
    }
  };
  const run = async <T extends QueryResultRow>(statement: Statement) =>
    f.run<T>(statement.context, statement.sql, statement.values ?? []);

  return {
    ...f,
    admin,
    seat,
    today,
    goTo,
    plus,
    freshSunday,
    freshDay,
    door,
    call,
    saveQuestion,
    questions,
    setChallenge,
    setWord,
    listWords,
    setCadence,
    challengeToday,
    answer,
    guess,
    own,
    xpOf,
    xpHolds,
    switchFeature,
    xpSetting,
    streakDays,
    held,
    asPlayerStatement,
    runStatement: run,
  };
}

export type DailyFixture = Awaited<ReturnType<typeof dailyFixture>>;
