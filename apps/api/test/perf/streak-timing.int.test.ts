import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { expect, it } from "vitest";
import { withRequestContext } from "#src/db/context";
import { TEST_DATABASE_URL, createTestDatabase, seedTwoTenants } from "#test/support/test-db";

/**
 * Times the streak trigger at the entrance burst (T-405, plan "Timing"; re-timed by T-406): 300 completions at once,
 * each the player's first of the day, from two API-like pools of 10 connections each, on a multi-day event with the
 * streak on and a bonus (every player played yesterday, so every completion writes both day rows and pays the bonus)
 * against the same burst on a single-day event with the daily streak switched off (no streak work at all). T-406 adds
 * two kinds: `daily` runs the streak burst while a third pool of 10 finishes 300 daily challenges of the same players at
 * once (each finish writes the same daily streak row first, so the pairs collide on it), and `load` the same with 300
 * players outside the event (the same extra load, no shared row), so `daily` over `load` is the shared row's cost
 * alone. Each burst runs in a fresh event, the order alternates, and the medians over the rounds are compared. Not an
 * assertion on time (a timing check is flaky on a 2-core runner): run it by hand when the trigger or the daily doors
 * change, `STREAK_TIMING=/path/to/out.txt pnpm vitest run apps/api/test/perf/streak-timing.int.test.ts`.
 * Target (ADR-303): every streak completion paid one bonus and every daily finish paid; the streak burst's p95 within
 * about 20 ms of the plain one, and the shared row (`daily` over `load`) adding little to it, inside NFR-002's 1 s.
 */
const OUT = process.env["STREAK_TIMING"];
const say = (line: string) => appendFileSync(String(OUT), `${line}\n`);
const BURST = 300;
const ROUNDS = 6;
const ORDERS: readonly (readonly Kind[])[] = [
  ["plain", "rows", "streak", "load", "daily"],
  ["rows", "streak", "load", "daily", "plain"],
  ["streak", "load", "daily", "plain", "rows"],
  ["load", "daily", "plain", "rows", "streak"],
  ["daily", "plain", "rows", "streak", "load"],
];

/**
 * No streak work; both day rows without a bonus; both day rows and the bonus; the bonus burst while 300 other players
 * finish the daily challenge (the same load, no shared row); the bonus burst while the same players finish it (each
 * pair writes the same daily streak row).
 */
type Kind = "plain" | "rows" | "streak" | "load" | "daily";

const percentile = (times: readonly number[], share: number) => {
  const sorted = times.toSorted((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * share) - 1)] ?? 0;
};

/** One completion through `pool`, as the API runs it: its time in ms. */
const complete = async (pool: Pool, player: string, quest: string) => {
  const client = await pool.connect();
  const started = performance.now();
  try {
    await withRequestContext(client, { playerId: player }, () =>
      client.query("SELECT * FROM complete_quest($1, 'qr', 1, NULL, $2, NULL)", [
        quest,
        randomUUID(),
      ]),
    );
  } finally {
    client.release();
  }
  return performance.now() - started;
};

/** One daily answer through `pool`, as the API runs it: its time in ms. */
const answer = async (pool: Pool, player: string, move: readonly unknown[]) => {
  const client = await pool.connect();
  const started = performance.now();
  try {
    await withRequestContext(client, { playerId: player }, () =>
      client.query("SELECT daily_answer_submit($1, $2, $3, $4) AS r", [...move]),
    );
  } finally {
    client.release();
  }
  return performance.now() - started;
};

it.skipIf(OUT === undefined || TEST_DATABASE_URL === undefined)(
  "times 300 first completions of the day with the streak and its bonus against none, and against daily finishes",
  async () => {
    const db = await createTestDatabase();
    const pools = [
      new Pool({ connectionString: db.appUrl, max: 10 }),
      new Pool({ connectionString: db.appUrl, max: 10 }),
      new Pool({ connectionString: db.appUrl, max: 10 }),
    ];
    const [first, second, third] = pools as [Pool, Pool, Pool];
    let counter = 0;
    try {
      const ids = await seedTwoTenants(db.owner);
      const q = (sql: string, values: unknown[] = []) => db.owner.query(sql, values);
      // The daily challenge needs content for today, which can only be set for a future day: this database's Questify
      // day reads a shift (as test/support/daily.ts does), the cadence is daily from tomorrow, and each daily burst
      // sets the next day's challenge, then moves the clock onto it.
      await q("CREATE TABLE test_clock (shift interval NOT NULL)");
      await q("INSERT INTO test_clock (shift) VALUES ('0 days')");
      await q("GRANT SELECT ON test_clock TO PUBLIC");
      await q(
        `CREATE OR REPLACE FUNCTION questify_day(at timestamptz) RETURNS date
           LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
           SELECT (((at + (SELECT c.shift FROM test_clock c)) AT TIME ZONE 'Asia/Riyadh') - interval '4 hours')::date
         $$`,
      );
      await q(
        "INSERT INTO daily_cadence (kind, from_day, cadence) VALUES ('challenge', questify_day(now()) + 1, 'daily')",
      );
      await q("UPDATE test_clock SET shift = shift + interval '1 day'");
      const admin = (
        await q(
          "INSERT INTO staff_user (email, password_hash, platform_role) VALUES ('timing@questify.test', 'h', 'admin') RETURNING id",
        )
      ).rows[0].id as string;
      const asAdmin = async (sql: string, values: unknown[]) => {
        const client = await first.connect();
        try {
          return await withRequestContext(
            client,
            { isAdmin: true, staffUserId: admin },
            async () => (await client.query(sql, values)).rows[0].r,
          );
        } finally {
          client.release();
        }
      };
      /** Tomorrow's challenge of three new questions (the right option is 1), then the clock moved onto it. */
      const challengeTomorrow = async () => {
        const picked: string[] = [];
        for (let n = 0; n < 3; n += 1) {
          const fields = {
            prompt: { ar: `سؤال ${counter}-${n}`, en: `Question ${counter}-${n}` },
            options: [
              { ar: "أ", en: "A" },
              { ar: "ب", en: "B" },
            ],
            answer: 1,
          };
          const made = await asAdmin(
            "SELECT daily_question_save(NULL, $1::jsonb, gen_random_uuid()) AS r",
            [JSON.stringify(fields)],
          );
          picked.push(made.id);
        }
        const tomorrow = (await q("SELECT (questify_day(now()) + 1)::text AS d")).rows[0]
          .d as string;
        const made = await asAdmin(
          "SELECT daily_challenge_set($1, $2::uuid[], NULL, gen_random_uuid()) AS r",
          [tomorrow, picked],
        );
        await q("UPDATE test_clock SET shift = shift + interval '1 day'");
        return { id: made.id as number, picked };
      };
      /** One burst in a fresh live event with BURST members who all played yesterday. */
      const burst = async (kind: Kind) => {
        counter += 1;
        await q(
          `INSERT INTO platform_setting (key, value)
           VALUES ('features', jsonb_build_object('dailyStreak', jsonb_build_object('enabled', $1::boolean)))
           ON CONFLICT (key) DO UPDATE SET value = platform_setting.value || excluded.value`,
          [kind !== "plain"],
        );
        const event = (
          await q(
            `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at, timezone, day_start_hour)
             VALUES ($1, $2, 'Gate Fest', 'live', now() - $3::interval, now() + $3::interval, 'UTC',
                     (extract(hour FROM now() AT TIME ZONE 'UTC')::int + 12) % 24)
             RETURNING id`,
            [ids.orgA, `STT${counter}`, kind === "plain" ? "1 hour" : "3 days"],
          )
        ).rows[0].id;
        const category = (
          await q("INSERT INTO category (event_id, name_en) VALUES ($1, 'Gate') RETURNING id", [
            event,
          ])
        ).rows[0].id;
        const quest = (
          await q(
            `INSERT INTO quest (event_id, category_id, type, title_en, points, repeat_cap)
             VALUES ($1, $2, 'scan_qr', 'Entrance', 10, 1) RETURNING id`,
            [event, category],
          )
        ).rows[0].id;
        const players = (
          await q(
            `WITH p AS (INSERT INTO player (username)
                        SELECT 'stt_' || $1 || '_' || n FROM generate_series(1, ${BURST}) n RETURNING id)
             INSERT INTO enrollment (organizer_id, event_id, player_id) SELECT $2, $3, p.id FROM p
             RETURNING id, player_id`,
            [counter, ids.orgA, event],
          )
        ).rows as { id: string; player_id: string }[];
        if (kind !== "plain") {
          await q(
            `INSERT INTO event_streak (event_id, organizer_id, enabled, bonus_points) VALUES ($1, $2, $3, 5)`,
            [event, ids.orgA, kind === "streak" || kind === "load" || kind === "daily"],
          );
          const seed = (
            await q(
              `INSERT INTO quest (event_id, category_id, type, title_en, points, repeat_cap, visible)
               VALUES ($1, $2, 'scan_qr', 'Yesterday', 10, 1, false) RETURNING id`,
              [event, category],
            )
          ).rows[0].id;
          await q(
            `WITH c AS (
               INSERT INTO quest_completion (organizer_id, event_id, enrollment_id, quest_id, occurrence, method,
                                             idempotency_key)
               SELECT $1, $2, n.id, $3, 1, 'qr', gen_random_uuid()::text
               FROM enrollment n WHERE n.event_id = $2 RETURNING id, enrollment_id)
             INSERT INTO event_streak_day (enrollment_id, day, organizer_id, event_id, days, completion_id)
             SELECT c.enrollment_id, event_day(now(), e) - 1, $1, $2, 1, c.id FROM c, event e WHERE e.id = $2`,
            [ids.orgA, event, seed],
          );
        }
        // The daily kinds: every finisher has answered two of today's three questions; the third finishes in the burst.
        // `daily`: the burst's own players; `load`: as many players outside the event.
        const daily = kind === "daily" || kind === "load" ? await challengeTomorrow() : undefined;
        const finishers =
          kind === "load"
            ? ((
                await q(
                  `INSERT INTO player (username) SELECT 'stl_' || $1 || '_' || n FROM generate_series(1, ${BURST}) n
                   RETURNING id AS player_id`,
                  [counter],
                )
              ).rows as { player_id: string }[])
            : players;
        if (daily !== undefined) {
          for (const pos of [1, 2]) {
            await Promise.all(
              finishers.map((player, index) =>
                answer(pools[index % 3] as Pool, player.player_id, [
                  daily.id,
                  daily.picked[pos - 1],
                  pos,
                  1,
                ]),
              ),
            );
          }
        }
        await q(
          "ANALYZE quest_completion, ledger_entry, enrollment, event_streak_day, questify_streak_day, daily_play, daily_answer",
        );
        const finishes =
          daily === undefined
            ? []
            : finishers.map((player) =>
                answer(third, player.player_id, [daily.id, daily.picked[2], 3, 1]),
              );
        const times = await Promise.all(
          players.map((player, index) =>
            complete(index % 2 === 0 ? first : second, player.player_id, quest),
          ),
        );
        const finishTimes = await Promise.all(finishes);
        const paid = (
          await q(
            "SELECT count(*)::int AS n FROM ledger_entry WHERE event_id = $1 AND kind = 'streak'",
            [event],
          )
        ).rows[0].n;
        const finished = (
          await q(
            `SELECT count(*)::int AS n FROM daily_finish f JOIN daily_play y ON y.id = f.play_id
             WHERE y.challenge_id = $1 AND f.xp = 50`,
            [daily?.id ?? 0],
          )
        ).rows[0].n;
        return {
          p50: percentile(times, 0.5),
          p95: percentile(times, 0.95),
          finishP95: percentile(finishTimes, 0.95),
          paid,
          finished,
        };
      };
      const results: Record<Kind, { p50: number; p95: number; finishP95: number }[]> = {
        plain: [],
        rows: [],
        streak: [],
        load: [],
        daily: [],
      };
      await burst("plain");
      for (let round = 0; round < ROUNDS; round += 1) {
        for (const kind of ORDERS[round % ORDERS.length] ?? []) {
          const result = await burst(kind);
          expect(result.paid).toBe(kind === "rows" || kind === "plain" ? 0 : BURST);
          expect(result.finished).toBe(kind === "daily" || kind === "load" ? BURST : 0);
          results[kind].push(result);
        }
      }
      const median = (values: readonly number[]) => percentile(values, 0.5);
      for (const kind of ["plain", "rows", "streak", "load", "daily"] as const) {
        say(
          `streak timing, ${kind}: p95 per round ${results[kind].map((r) => r.p95.toFixed(0)).join(", ")} ms;` +
            ` median p95 ${median(results[kind].map((r) => r.p95)).toFixed(1)} ms,` +
            ` median p50 ${median(results[kind].map((r) => r.p50)).toFixed(1)} ms`,
        );
      }
      const plain = median(results.plain.map((r) => r.p95));
      const streak = median(results.streak.map((r) => r.p95));
      const rows = median(results.rows.map((r) => r.p95));
      const daily = median(results.daily.map((r) => r.p95));
      const load = median(results.load.map((r) => r.p95));
      const over = (value: number) =>
        `${((value / plain - 1) * 100).toFixed(1)}% (+${(value - plain).toFixed(1)} ms)`;
      say(`streak timing: rows/plain median p95 ${over(rows)}`);
      say(`streak timing: streak/plain median p95 ${over(streak)}`);
      say(`streak timing: load/plain median p95 ${over(load)}`);
      say(`streak timing: daily/plain median p95 ${over(daily)}`);
      say(
        `streak timing: daily over load (the shared row alone) median p95 +${(daily - load).toFixed(1)} ms`,
      );
      say(
        `streak timing: daily finishes' median p95 ${median(results.daily.map((r) => r.finishP95)).toFixed(1)} ms` +
          ` (load: ${median(results.load.map((r) => r.finishP95)).toFixed(1)} ms)`,
      );
    } finally {
      await Promise.all(pools.map((pool) => pool.end()));
      await db.close();
    }
  },
  900_000,
);
