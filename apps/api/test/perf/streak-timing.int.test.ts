import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { expect, it } from "vitest";
import { withRequestContext } from "#src/db/context";
import { TEST_DATABASE_URL, createTestDatabase, seedTwoTenants } from "#test/support/test-db";

/**
 * Times the streak trigger at the entrance burst (T-405, plan "Timing"): 300 completions at once, each the player's
 * first of the day, from two API-like pools of 10 connections each, on a multi-day event with the streak on and a bonus
 * (every player played yesterday, so every completion writes both day rows and pays the bonus) against the same burst
 * on a single-day event with the daily streak switched off (no streak work at all). Each burst runs in a fresh event,
 * the order alternates, and the medians over the rounds are compared. Not an assertion on time (a timing check is
 * flaky on a 2-core runner): run it by hand when the trigger changes,
 * `STREAK_TIMING=/path/to/out.txt pnpm vitest run apps/api/test/perf/streak-timing.int.test.ts`.
 * Target (plan): every streak completion paid one bonus, and the streak burst's p95 within 10% of the plain one.
 */
const OUT = process.env["STREAK_TIMING"];
const say = (line: string) => appendFileSync(String(OUT), `${line}\n`);
const BURST = 300;
const ROUNDS = 6;
const ORDERS: readonly (readonly Kind[])[] = [
  ["plain", "rows", "streak"],
  ["rows", "streak", "plain"],
  ["streak", "plain", "rows"],
];

/** No streak work; both day rows without a bonus; both day rows and the bonus. */
type Kind = "plain" | "rows" | "streak";

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

it.skipIf(OUT === undefined || TEST_DATABASE_URL === undefined)(
  "times 300 first completions of the day with the streak and its bonus against none",
  async () => {
    const db = await createTestDatabase();
    const pools = [
      new Pool({ connectionString: db.appUrl, max: 10 }),
      new Pool({ connectionString: db.appUrl, max: 10 }),
    ];
    let counter = 0;
    try {
      const ids = await seedTwoTenants(db.owner);
      const q = (sql: string, values: unknown[] = []) => db.owner.query(sql, values);
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
            [event, ids.orgA, kind === "streak"],
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
        await q(
          "ANALYZE quest_completion, ledger_entry, enrollment, event_streak_day, questify_streak_day",
        );
        const times = await Promise.all(
          players.map((player, index) =>
            complete(pools[index % 2] as Pool, player.player_id, quest),
          ),
        );
        const paid = (
          await q(
            "SELECT count(*)::int AS n FROM ledger_entry WHERE event_id = $1 AND kind = 'streak'",
            [event],
          )
        ).rows[0].n;
        return { p50: percentile(times, 0.5), p95: percentile(times, 0.95), paid };
      };
      const results: Record<Kind, { p50: number; p95: number }[]> = {
        plain: [],
        rows: [],
        streak: [],
      };
      await burst("plain");
      for (let round = 0; round < ROUNDS; round += 1) {
        for (const kind of ORDERS[round % ORDERS.length] ?? []) {
          const result = await burst(kind);
          expect(result.paid).toBe(kind === "streak" ? BURST : 0);
          results[kind].push(result);
        }
      }
      const median = (values: readonly number[]) => percentile(values, 0.5);
      for (const kind of ["plain", "rows", "streak"] as const) {
        say(
          `streak timing, ${kind}: p95 per round ${results[kind].map((r) => r.p95.toFixed(0)).join(", ")} ms;` +
            ` median p95 ${median(results[kind].map((r) => r.p95)).toFixed(1)} ms,` +
            ` median p50 ${median(results[kind].map((r) => r.p50)).toFixed(1)} ms`,
        );
      }
      const plain = median(results.plain.map((r) => r.p95));
      const streak = median(results.streak.map((r) => r.p95));
      const rows = median(results.rows.map((r) => r.p95));
      say(`streak timing: rows/plain median p95 ${((rows / plain - 1) * 100).toFixed(1)}%`);
      say(`streak timing: streak/plain median p95 ${((streak / plain - 1) * 100).toFixed(1)}%`);
    } finally {
      await Promise.all(pools.map((pool) => pool.end()));
      await db.close();
    }
  },
  600_000,
);
