import { appendFileSync } from "node:fs";
import { it } from "vitest";
import { TEST_DATABASE_URL, createTestDatabase, seedTwoTenants } from "#test/support/test-db";

/**
 * Times the community tick (T-306b, ADR-222, ADR-223): one settle_goal over a minute of 20,000 completions, then paying
 * 10,000 players in batches of 500. Not an assertion (a timing check is flaky on a 2-core runner), like the ranking
 * timing: run it by hand when the settling or paying SQL changes,
 * `COMMUNITY_TIMING=/path/to/out.txt pnpm vitest run apps/api/test/perf/community-payer-timing.int.test.ts`.
 * Targets (plan): the settle under 100 ms, a batch under 250 ms, 10,000 players within 30 s.
 */
const OUT = process.env["COMMUNITY_TIMING"];
const say = (line: string) => appendFileSync(String(OUT), `${line}\n`);

it.skipIf(OUT === undefined || TEST_DATABASE_URL === undefined)(
  "times one settle over 20,000 completions and paying 10,000 players",
  async () => {
    const db = await createTestDatabase();
    try {
      const ids = await seedTwoTenants(db.owner);
      const q = (sql: string, values: unknown[] = []) => db.owner.query(sql, values);
      await q("INSERT INTO player (username) SELECT 'cp_' || n FROM generate_series(1, 10000) n");
      await q(
        "INSERT INTO enrollment (organizer_id, event_id, player_id) SELECT $1, $2, id FROM player WHERE username LIKE 'cp_%'",
        [ids.orgA, ids.eventA],
      );
      const category = (
        await q("INSERT INTO category (event_id, name_en) VALUES ($1, 'All') RETURNING id", [
          ids.eventA,
        ])
      ).rows[0].id;
      const quest = (
        await q(
          `INSERT INTO quest (event_id, category_id, type, title_en, points, repeat_cap)
           VALUES ($1, $2, 'scan_qr', 'Scan', 10, 100) RETURNING id`,
          [ids.eventA, category],
        )
      ).rows[0].id;
      // 20,000 completions over one minute, five minutes ago: two per player.
      await q(
        `WITH c AS (
           INSERT INTO quest_completion (organizer_id, event_id, enrollment_id, quest_id, occurrence, method,
                                         idempotency_key, created_at)
           SELECT n.organizer_id, n.event_id, n.id, $2, k, 'qr', gen_random_uuid()::text,
                  now() - interval '6 minutes' + (random() * interval '1 minute')
           FROM enrollment n CROSS JOIN generate_series(1, 2) k WHERE n.event_id = $1
           RETURNING *)
         INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta,
                                   completion_id, quest_id, actor, created_at)
         SELECT c.organizer_id, c.event_id, c.enrollment_id, 'quest', 10, 10, c.id, c.quest_id, 'player', c.created_at
         FROM c`,
        [ids.eventA, quest],
      );
      const goal = (
        await q(
          `INSERT INTO community_goal (organizer_id, event_id, title_en, measure, target, starts_at, ends_at, paid_to)
           VALUES ($1, $2, 'Timing', 'points', 1000000, now() - interval '7 minutes', now() + interval '1 hour',
                   'everyone') RETURNING id`,
          [ids.orgA, ids.eventA],
        )
      ).rows[0].id;
      await q(
        `INSERT INTO community_step (event_id, goal_id, threshold, is_goal, reward, points)
         VALUES ($1, $2, 150000, false, 'points', 5), ($1, $2, 1000000, true, 'points', 50)`,
        [ids.eventA, goal],
      );
      await q("ANALYZE");
      let start = performance.now();
      await q("SELECT settle_goal($1, true)", [goal]);
      say(
        `first settle_goal over 20,000 completions (10,000 new contributors, 10,000 payees frozen): ${(performance.now() - start).toFixed(1)} ms`,
      );
      // A steady tick at 20,000 completions a minute: 5 s of new rows below the settle point, the tail re-read.
      await q(
        `WITH c AS (
           INSERT INTO quest_completion (organizer_id, event_id, enrollment_id, quest_id, occurrence, method,
                                         idempotency_key, created_at)
           SELECT n.organizer_id, n.event_id, n.id, $2, 3, 'qr', gen_random_uuid()::text,
                  now() - interval '40 seconds' + (random() * interval '5 seconds')
           FROM enrollment n WHERE n.event_id = $1 ORDER BY n.id LIMIT 1700
           RETURNING *)
         INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta,
                                   completion_id, quest_id, actor, created_at)
         SELECT c.organizer_id, c.event_id, c.enrollment_id, 'quest', 10, 10, c.id, c.quest_id, 'player', c.created_at
         FROM c`,
        [ids.eventA, quest],
      );
      await q(
        "UPDATE community_goal SET settled_until = now() - interval '45 seconds' WHERE id = $1",
        [goal],
      );
      start = performance.now();
      await q("SELECT settle_goal($1, true)", [goal]);
      say(`steady settle_goal (1,700 new rows): ${(performance.now() - start).toFixed(1)} ms`);
      const due = (await q("SELECT count(*)::int AS n FROM community_payout WHERE status = 'due'"))
        .rows[0].n;
      say(`payout rows frozen: ${due}`);
      const batches: number[] = [];
      start = performance.now();
      for (;;) {
        const one = performance.now();
        const { rows } = await q("SELECT * FROM pay_community_batch(500, NULL)");
        if (rows.length === 0) {
          break;
        }
        batches.push(performance.now() - one);
      }
      const total = performance.now() - start;
      const slowest = Math.max(...batches);
      say(
        `paid ${due} players in ${batches.length} batches: ${total.toFixed(0)} ms in all, slowest batch ${slowest.toFixed(1)} ms`,
      );
    } finally {
      await db.close();
    }
  },
  600_000,
);
