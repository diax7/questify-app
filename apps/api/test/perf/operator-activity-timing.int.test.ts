import { appendFileSync } from "node:fs";
import { it } from "vitest";
import { questifyFixture } from "#test/support/questify";
import { TEST_DATABASE_URL } from "#test/support/test-db";

/**
 * Times the operator activity door (T-617, migration 0111) on an event of 50,000 players, 60 operators and about 400,000
 * operator entries (250,000 of them in the last three hours, 150,000 two days ago), 20,000 awards, 6,000 reviews and
 * 2,000 answers, beside a neighbour event of 20 operators and 150,000 entries. Not an assertion (a timing check is flaky
 * on a 2-core runner): run it by hand when the door changes,
 * `OPERATOR_TIMING=/path/to/out.txt pnpm vitest run apps/api/test/perf/operator-activity-timing.int.test.ts`.
 * Target: the door answers in well under a second, and the ledger is read through `ledger_entry_operator_event_idx`.
 */
const OUT = process.env["OPERATOR_TIMING"];
const say = (line: string) => appendFileSync(String(OUT), `${line}\n`);
const PLAYERS = 50_000;
const OPERATORS = 60;

it.skipIf(OUT === undefined || TEST_DATABASE_URL === undefined)(
  "times the operator activity door on a 50,000-player event",
  async () => {
    const f = await questifyFixture();
    try {
      const event = await f.newEvent({ phase: "live" });
      const neighbour = await f.newEvent({ phase: "live" });
      const q = (sql: string, values: unknown[] = []) => f.db.owner.query(sql, values);
      const [org] = (await q("SELECT organizer_id FROM event WHERE id = $1", [event])).rows;
      const organizer = org.organizer_id as string;
      for (const target of [event, neighbour]) {
        for (let i = 0; i < 20; i += 1) {
          await q(
            `INSERT INTO quest (event_id, category_id, type, title_en, points, repeat_cap, visible, type_config)
             SELECT $1, id, 'scan_qr', $2, 10, 100, true, '{}' FROM category WHERE event_id = $1 LIMIT 1`,
            [target, `Station ${i}`],
          );
        }
      }
      await q("BEGIN");
      await q("SET LOCAL session_replication_role = replica");
      await q("INSERT INTO player (username) SELECT 'ot_' || n FROM generate_series(1, $1) n", [
        PLAYERS + OPERATORS + 20,
      ]);
      await q(
        `INSERT INTO enrollment (organizer_id, event_id, player_id, joined_via, joined_at, score, balance)
         SELECT $1, $2, p.id, 'code', now() - random() * interval '3 days', 100, 80
         FROM (SELECT id FROM player WHERE username LIKE 'ot_%' ORDER BY username LIMIT $3) p`,
        [organizer, event, PLAYERS],
      );
      await q(
        `INSERT INTO enrollment (organizer_id, event_id, player_id, joined_via, joined_at, score, balance)
         SELECT $1, $2, p.id, 'code', now() - random() * interval '3 days', 100, 80
         FROM (SELECT id FROM player WHERE username LIKE 'ot_%' ORDER BY username LIMIT 5000) p`,
        [organizer, neighbour],
      );
      await q(
        `INSERT INTO staff_assignment (organizer_id, event_id, player_id)
         SELECT $1, $2, p.id FROM (SELECT id FROM player WHERE username LIKE 'ot_%' ORDER BY username DESC LIMIT $3) p`,
        [organizer, event, OPERATORS],
      );
      await q(
        `INSERT INTO staff_assignment (organizer_id, event_id, player_id)
         SELECT $1, $2, p.id FROM (SELECT id FROM player WHERE username LIKE 'ot_%' ORDER BY username DESC
                                   OFFSET $3 LIMIT 20) p`,
        [organizer, neighbour, OPERATORS],
      );
      for (const [target, entries, hoursMin, hoursMax, base] of [
        [event, 250_000, 0, 3, 0],
        [event, 150_000, 40, 60, 10],
        [neighbour, 150_000, 0, 3, 0],
      ] as const) {
        await q(
          `WITH ops AS (SELECT player_id, row_number() OVER (ORDER BY player_id) AS m
                        FROM staff_assignment WHERE event_id = $1),
                enr AS (SELECT id, row_number() OVER (ORDER BY id) AS n FROM enrollment WHERE event_id = $1),
                quests AS (SELECT id, row_number() OVER (ORDER BY id) AS k FROM quest WHERE event_id = $1),
                made AS (
                  INSERT INTO quest_completion (organizer_id, event_id, enrollment_id, quest_id, occurrence, method,
                                                idempotency_key, created_at)
                  SELECT $2, $1, e.id, qu.id, $6::integer + 1 + g.i / (SELECT count(*)::integer FROM enr), 'my_qr', gen_random_uuid()::text,
                         now() - ($4 * interval '1 hour' + random() * ($5 - $4) * interval '1 hour')
                  FROM generate_series(1, $3::integer) g(i)
                  JOIN enr e ON e.n = 1 + g.i % (SELECT count(*) FROM enr)
                  JOIN quests qu ON qu.k = 1 + g.i % 20
                  RETURNING id, enrollment_id, quest_id, created_at)
           INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta,
                                     completion_id, quest_id, actor, operator_id, created_at)
           SELECT $2, $1, m.enrollment_id, 'quest', 10, 10, m.id, m.quest_id, 'operator',
                  (SELECT player_id FROM ops WHERE ops.m = 1 + (m.id % (SELECT count(*) FROM ops))), m.created_at
           FROM made m`,
          [target, organizer, entries, hoursMin, hoursMax, base],
        );
      }
      await q(
        `INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta, actor,
                                   operator_id, created_at)
         SELECT $2, $1, e.id, 'award', 5, 5, 'operator',
                (SELECT player_id FROM staff_assignment WHERE event_id = $1 ORDER BY player_id OFFSET e.n % $3 LIMIT 1),
                now() - random() * interval '3 hours'
         FROM (SELECT id, row_number() OVER (ORDER BY id) AS n FROM enrollment WHERE event_id = $1 LIMIT 20000) e`,
        [event, organizer, OPERATORS],
      );
      await q(
        `INSERT INTO submission (organizer_id, event_id, enrollment_id, quest_id, kind, body, points, status, reason,
                                 reviewed_by_operator, review_key, reviewed_at, idempotency_key)
         SELECT $2, $1, e.id, (SELECT id FROM quest WHERE event_id = $1 LIMIT 1), 'text', 'a', 10, 'rejected', 'x',
                (SELECT player_id FROM staff_assignment WHERE event_id = $1 ORDER BY player_id OFFSET e.n % $3 LIMIT 1),
                e.n::text, now() - random() * interval '3 hours', gen_random_uuid()::text
         FROM (SELECT id, row_number() OVER (ORDER BY id) AS n FROM enrollment WHERE event_id = $1 LIMIT 6000) e`,
        [event, organizer, OPERATORS],
      );
      await q(
        `INSERT INTO ticket (player_id, organizer_id, event_id, enrollment_id, kind, body, status, outcome, closed_at,
                             answer_key, answered_by_operator, idempotency_key)
         SELECT p.player_id, $2, $1, e.id, 'question', 'q', 'closed', 'solved', now() - random() * interval '3 hours',
                e.n::text,
                (SELECT player_id FROM staff_assignment WHERE event_id = $1 ORDER BY player_id OFFSET e.n % $3 LIMIT 1),
                gen_random_uuid()::text
         FROM (SELECT id, player_id, row_number() OVER (ORDER BY id) AS n FROM enrollment WHERE event_id = $1
               LIMIT 2000) e
         JOIN enrollment p ON p.id = e.id`,
        [event, organizer, OPERATORS],
      );
      await q("COMMIT");
      await q("ANALYZE");
      const [count] = (
        await q("SELECT count(*)::int AS n FROM ledger_entry WHERE operator_id IS NOT NULL")
      ).rows;
      say(`seeded ${PLAYERS} players, ${OPERATORS} operators, ${count.n} operator entries`);
      const door = async (label: string, recent: number) => {
        const times: number[] = [];
        for (let i = 0; i < 6; i += 1) {
          const started = performance.now();
          await f.run(f.team(), "SELECT operator_activity($1, $2)", [event, recent]);
          times.push(performance.now() - started);
        }
        say(`${label}: ${times.map((t) => t.toFixed(0)).join(" ")} ms (first is cold)`);
      };
      const part = async (label: string, sql: string) => {
        const times: number[] = [];
        for (let i = 0; i < 4; i += 1) {
          const started = performance.now();
          await q(sql, [event]);
          times.push(performance.now() - started);
        }
        say(`${label}: ${times.map((t) => t.toFixed(0)).join(" ")} ms`);
      };
      const rows =
        "SELECT operator_activity_rows(e, event_day_start(e, event_day(now(), e)), now() - interval '1 hour') FROM event e WHERE id = $1";
      const recent = "SELECT operator_activity_recent(e, 5) FROM event e WHERE id = $1";
      const latest = `SELECT o.player_id, ll.kind, ll.at FROM staff_assignment o
        LEFT JOIN LATERAL (SELECT l.kind, l.created_at AS at FROM ledger_entry l
                           WHERE l.event_id = $1 AND l.operator_id = o.player_id ORDER BY l.created_at DESC LIMIT 1) ll ON true
        WHERE o.event_id = $1`;
      const reviews = `SELECT o.player_id, r.today, r.last_at FROM staff_assignment o
        CROSS JOIN LATERAL (SELECT count(*) FILTER (WHERE s.reviewed_at >= now() - interval '2 hours') AS today, max(s.reviewed_at) AS last_at
                            FROM submission s WHERE s.event_id = $1 AND s.reviewed_by_operator = o.player_id) r
        WHERE o.event_id = $1`;
      const answers = `SELECT o.player_id, a.today, a.last_at FROM staff_assignment o
        CROSS JOIN LATERAL (SELECT count(*) FILTER (WHERE t.closed_at >= now() - interval '2 hours') AS today, max(t.closed_at) AS last_at
                            FROM ticket t WHERE t.event_id = $1 AND t.answered_by_operator = o.player_id) a
        WHERE o.event_id = $1`;
      await door("operator_activity(recent 5), tables not vacuumed", 5);
      await q("VACUUM (ANALYZE) ledger_entry");
      await q("VACUUM (ANALYZE) submission");
      await q("VACUUM (ANALYZE) ticket");
      await door("operator_activity(recent 5), vacuumed", 5);
      await door("operator_activity(recent 50), vacuumed", 50);
      await part("rows only", rows);
      await part("recent only", recent);
      await part("latest only", latest);
      await part("reviews only", reviews);
      await part("answers only", answers);
      await q("DROP INDEX ledger_entry_operator_event_idx");
      await q("DROP INDEX submission_operator_reviewed_idx");
      await q("DROP INDEX ticket_operator_answered_idx");
      await q("ANALYZE");
      await door("operator_activity(recent 5), without the three indexes", 5);
    } finally {
      await f.close();
    }
  },
  1_800_000,
);
