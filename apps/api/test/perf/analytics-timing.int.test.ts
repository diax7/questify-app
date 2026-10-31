import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { it } from "vitest";
import { questifyFixture } from "#test/support/questify";
import { TEST_DATABASE_URL } from "#test/support/test-db";

/**
 * Times the three analytics doors (T-607, migration 0102) on an event of 50,000 players, 20 quests, about 350,000 first
 * completions, 150,000 repeats, 60,000 event days and 3,000 redemptions with their points entries, 1,000 removed awards
 * and 50,000 other manual entries (a bulk award to every player). Not an assertion (a timing check is flaky on a
 * 2-core runner): run it by hand when the doors change,
 * `ANALYTICS_TIMING=/path/to/out.txt pnpm vitest run apps/api/test/perf/analytics-timing.int.test.ts`.
 * Target: each door under about 1 s, and none reads the points record.
 */
const OUT = process.env["ANALYTICS_TIMING"];
const say = (line: string) => appendFileSync(String(OUT), `${line}\n`);
const PLAYERS = 50_000;
const ACTIVE = 35_000;

it.skipIf(OUT === undefined || TEST_DATABASE_URL === undefined)(
  "times the analytics doors on a 50,000-player event",
  async () => {
    const f = await questifyFixture();
    try {
      const event = await f.newEvent({ phase: "live" });
      const [org] = await f.owner<{ organizer_id: string }>(
        "SELECT organizer_id FROM event WHERE id = $1",
        [event],
      );
      const organizer = org?.organizer_id;
      const q = (sql: string, values: unknown[] = []) => f.db.owner.query(sql, values);
      const categories: string[] = [];
      for (let i = 0; i < 4; i += 1) {
        const [row] = (
          await q(
            "INSERT INTO category (event_id, name_en, position, order_mode) VALUES ($1, $2, $3, $4) RETURNING id",
            [event, `Category ${i}`, i + 1, i % 2 === 0 ? "in_order" : "any"],
          )
        ).rows;
        categories.push(row.id as string);
      }
      for (let i = 0; i < 20; i += 1) {
        await q(
          `INSERT INTO quest (event_id, category_id, type, title_en, points, repeat_cap, visible, position)
           VALUES ($1, $2, 'scan_qr', $3, 10, 100, true, $4)`,
          [event, categories[i % 4], `Quest ${i}`, i],
        );
      }
      for (let i = 0; i < 15; i += 1) {
        await q(
          `INSERT INTO reward (event_id, kind, name_en, price, stock_total, units_out, position)
           VALUES ($1, 'experience', $2, 50, 100000, 200, $3)`,
          [event, `Reward ${i}`, i],
        );
      }
      await q("BEGIN");
      await q("SET LOCAL session_replication_role = replica");
      await q("INSERT INTO player (username) SELECT 'ap_' || n FROM generate_series(1, $1) n", [
        PLAYERS,
      ]);
      await q(
        `INSERT INTO enrollment (organizer_id, event_id, player_id, joined_via, joined_at, score, balance)
         SELECT $1, $2, p.id, (ARRAY['code', 'qr', 'link', 'public_list', 'invite'])[1 + p.n % 5],
                now() - random() * interval '3 days', 100, 80
         FROM (SELECT id, row_number() OVER (ORDER BY id) AS n FROM player WHERE username LIKE 'ap_%') p`,
        [organizer, event],
      );
      await q(
        `INSERT INTO quest_completion (organizer_id, event_id, enrollment_id, quest_id, occurrence, method,
                                       idempotency_key, created_at)
         SELECT $1, $2, e.id, qu.id, o.k, 'qr', gen_random_uuid()::text, now() - random() * interval '3 days'
         FROM (SELECT id, row_number() OVER (ORDER BY id) AS n FROM enrollment WHERE event_id = $2) e
         JOIN (SELECT id, row_number() OVER (ORDER BY id) AS m FROM quest WHERE event_id = $2) qu
           ON qu.m <= 10
         CROSS JOIN generate_series(1, 2) o(k)
         WHERE e.n <= $3 AND (o.k = 1 OR qu.m <= 5)`,
        [organizer, event, ACTIVE],
      );
      await q(
        `INSERT INTO event_streak_day (enrollment_id, day, organizer_id, event_id, days, completion_id)
         SELECT c.enrollment_id, current_date - (c.r - 1)::integer, c.organizer_id, c.event_id, 1, c.id
         FROM (SELECT *, row_number() OVER (PARTITION BY enrollment_id ORDER BY id) AS r
               FROM quest_completion WHERE event_id = $1) c
         WHERE c.r = 1 OR (c.r = 2 AND c.id % 3 = 0)`,
        [event],
      );
      await q(
        `INSERT INTO redemption (organizer_id, event_id, enrollment_id, reward_id, price, status, idempotency_key,
                                 reserved_until, ended_at, ended_by, operator_id)
         SELECT $1, $2, e.id, r.id, 50, CASE WHEN e.n % 3 = 0 THEN 'reserved' ELSE 'handed_over' END,
                gen_random_uuid()::text, now() + interval '1 day',
                CASE WHEN e.n % 3 = 0 THEN NULL ELSE now() END,
                CASE WHEN e.n % 3 = 0 THEN NULL ELSE 'handover' END,
                CASE WHEN e.n % 3 = 0 THEN NULL ELSE gen_random_uuid() END
         FROM (SELECT id, row_number() OVER (ORDER BY id) AS n FROM enrollment WHERE event_id = $2) e
         JOIN (SELECT id, row_number() OVER (ORDER BY id) AS m FROM reward WHERE event_id = $2) r ON r.m = 1 + e.n % 15
         WHERE e.n <= 3000`,
        [organizer, event],
      );
      await q(
        `INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta,
                                   redemption_id, actor)
         SELECT organizer_id, event_id, enrollment_id, 'redeem', CASE WHEN id::text < '8' THEN -price ELSE 0 END,
                -price, id, 'player'
         FROM redemption WHERE event_id = $1`,
        [event],
      );
      await q(
        `INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta,
                                   completion_id, quest_id, actor)
         SELECT organizer_id, event_id, enrollment_id, 'quest', 10, 10, id, quest_id, 'player'
         FROM quest_completion WHERE event_id = $1 AND occurrence = 1 ORDER BY id LIMIT 5000`,
        [event],
      );
      await q(
        `INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta,
                                   completion_id, quest_id, actor, staff_user_id, reverses)
         SELECT organizer_id, event_id, enrollment_id, 'removal', -10, -10, completion_id, quest_id, 'staff',
                gen_random_uuid(), id
         FROM ledger_entry WHERE event_id = $1 AND kind = 'quest' ORDER BY id LIMIT 1000`,
        [event],
      );
      await q(
        `INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta, actor,
                                   staff_user_id)
         SELECT organizer_id, event_id, id, 'award', 5, 5, 'staff', gen_random_uuid()
         FROM enrollment WHERE event_id = $1`,
        [event],
      );
      await q(
        `INSERT INTO ledger_note (entry_id, organizer_id, event_id, reason, bulk_id)
         SELECT id, organizer_id, event_id, CASE WHEN kind = 'removal' THEN 'seeded' END,
                CASE WHEN kind = 'award' THEN $2::uuid END
         FROM ledger_entry WHERE event_id = $1 AND kind IN ('removal', 'award')`,
        [event, randomUUID()],
      );
      await q("COMMIT");
      await q("ANALYZE");
      say(`seeded ${PLAYERS} players, ${ACTIVE} active`);
      for (const door of ["analytics_participation", "analytics_quests", "analytics_economy"]) {
        const times: number[] = [];
        for (let run = 0; run < 4; run += 1) {
          const start = performance.now();
          await f.run(f.team(), `SELECT ${door}($1)`, [event]);
          times.push(performance.now() - start);
        }
        say(`${door}: ${times.map((time) => time.toFixed(0)).join(" ms, ")} ms (first, then warm)`);
      }
    } finally {
      await f.close();
    }
  },
  600_000,
);
