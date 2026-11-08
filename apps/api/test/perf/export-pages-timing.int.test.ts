import { appendFileSync } from "node:fs";
import { it } from "vitest";
import { questifyFixture, type QuestifyFixture } from "#test/support/questify";
import { TEST_DATABASE_URL } from "#test/support/test-db";

/**
 * Times the players, redemptions and submissions export doors (T-608, FOLLOWUPS batch 30, migration 0182) on an event
 * of 100,000 players, each with one join answer, one reward redemption and one text submission. Before 0182 a door
 * read the event whole in one call; since, it reads pages of 5,000 as the API does. Each figure is the sum over the
 * pages of one walk (`EXPLAIN (ANALYZE, BUFFERS)` of the door call, shared buffers hit and read), the largest page
 * answer, and the wall time of the walk's calls as the API's role makes them, median of 3 warm walks. Not an assertion: run it by hand when the doors change,
 * `EXPORT_PAGES_TIMING=/path/to/out.txt pnpm vitest run apps/api/test/perf/export-pages-timing.int.test.ts`.
 */
const OUT = process.env["EXPORT_PAGES_TIMING"];
const say = (line: string) => appendFileSync(String(OUT), `${line}\n`);
const PLAYERS = 100_000;
const PAGE = 5000;
const DOORS = ["export_players", "export_redemptions", "export_submissions"] as const;

async function seed(f: QuestifyFixture): Promise<string> {
  const event = await f.newEvent({ phase: "live" });
  const q = (sql: string, values: unknown[] = []) => f.db.owner.query(sql, values);
  await q(
    "INSERT INTO event_join_field (event_id, kind, required, position) VALUES ($1, 'company', true, 0)",
    [event],
  );
  for (let i = 0; i < 10; i += 1) {
    await q(
      `INSERT INTO quest (event_id, category_id, type, title_en, points, repeat_cap, visible, position)
       SELECT $1, (SELECT id FROM category WHERE event_id = $1 ORDER BY position LIMIT 1), 'scan_qr', $2, 10, 5,
              true, $3`,
      [event, `Quest ${i}`, i],
    );
    await q(
      `INSERT INTO reward (event_id, kind, name_en, price, stock_total, units_out, position)
       VALUES ($1, 'experience', $2, 50, 100000, 0, $3)`,
      [event, `Reward ${i}`, i],
    );
  }
  await q("BEGIN");
  await q("SET LOCAL session_replication_role = replica");
  await q("INSERT INTO player (username) SELECT 'xe_' || n FROM generate_series(1, $1) n", [
    PLAYERS,
  ]);
  // Ten players at a time share their join time with another one, so the id breaks real ties.
  await q(
    `INSERT INTO enrollment (organizer_id, event_id, player_id, joined_at, score, balance)
     SELECT e.organizer_id, e.id, p.id, now() - (p.n / 10) * interval '1 second', p.n % 500, 0
     FROM event e
     CROSS JOIN (SELECT id, substr(username, 4)::int AS n FROM player WHERE username LIKE 'xe\\_%') p
     WHERE e.id = $1`,
    [event],
  );
  await q(
    `INSERT INTO join_answer (enrollment_id, field_id, organizer_id, event_id, value)
     SELECT n.id, f.id, n.organizer_id, n.event_id, 'Company ' || (random() * 1000)::int
     FROM enrollment n JOIN event_join_field f ON f.event_id = n.event_id WHERE n.event_id = $1`,
    [event],
  );
  await q(
    `INSERT INTO redemption (organizer_id, event_id, enrollment_id, reward_id, price, status, idempotency_key,
                             reserved_until, created_at)
     SELECT n.organizer_id, n.event_id, n.id, r.id, 50, 'reserved', gen_random_uuid()::text, now() + interval '1 day',
            n.joined_at + interval '1 minute'
     FROM (SELECT *, row_number() OVER (ORDER BY id) AS k FROM enrollment WHERE event_id = $1) n
     JOIN (SELECT id, row_number() OVER (ORDER BY id) AS m FROM reward WHERE event_id = $1) r ON r.m = 1 + n.k % 10`,
    [event],
  );
  await q(
    `INSERT INTO submission (organizer_id, event_id, enrollment_id, quest_id, kind, body, points, status,
                             idempotency_key, created_at)
     SELECT n.organizer_id, n.event_id, n.id, qu.id, 'text', 'An answer of about forty characters, ' || n.k, 5,
            'pending', gen_random_uuid()::text, n.joined_at + interval '2 minutes'
     FROM (SELECT *, row_number() OVER (ORDER BY id) AS k FROM enrollment WHERE event_id = $1) n
     JOIN (SELECT id, row_number() OVER (ORDER BY id) AS m FROM quest WHERE event_id = $1) qu ON qu.m = 1 + n.k % 10`,
    [event],
  );
  await q("COMMIT");
  await q("ANALYZE");
  return event;
}

type Plan = [{ Plan: { "Shared Hit Blocks": number; "Shared Read Blocks": number } }];
type Cursor = { at: string; id: string | number } | null;
type Walk = {
  rows: number;
  pages: number;
  buffers: number;
  dbMs: number;
  wallMs: number;
  biggest: number;
};

async function walk(
  f: QuestifyFixture,
  door: string,
  event: string,
  paged: boolean,
): Promise<Walk> {
  const total: Walk = { rows: 0, pages: 0, buffers: 0, dbMs: 0, wallMs: 0, biggest: 0 };
  let cursor: Cursor = { at: "-infinity", id: "" };
  while (cursor !== null) {
    const call: string = paged
      ? `${door}($1, $2, ${door === "export_submissions" ? "$3::bigint" : "$3::uuid"}, ${PAGE})`
      : `${door}($1)`;
    const first = cursor.id === "";
    const values: unknown[] = paged
      ? [
          event,
          cursor.at,
          first
            ? door === "export_submissions"
              ? 0
              : "00000000-0000-0000-0000-000000000000"
            : cursor.id,
        ]
      : [event];
    const [explained] = await f.run<{ "QUERY PLAN": Plan }>(
      f.team(),
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT ${call}`,
      values,
    );
    const plan = explained?.["QUERY PLAN"][0];
    const started = performance.now();
    const [answer] = await f.run<{ d: unknown }>(f.team(), `SELECT ${call} AS d`, values);
    total.wallMs += performance.now() - started;
    const page = answer?.d as { rows: unknown[]; next: Cursor } | unknown[];
    const rows = Array.isArray(page) ? page : page.rows;
    total.pages += 1;
    total.rows += rows.length;
    total.biggest = Math.max(total.biggest, Buffer.byteLength(JSON.stringify(page)));
    total.buffers +=
      (plan?.Plan["Shared Hit Blocks"] ?? 0) + (plan?.Plan["Shared Read Blocks"] ?? 0);
    total.dbMs += (plan as unknown as { "Execution Time": number })["Execution Time"];
    cursor = Array.isArray(page) ? null : page.next;
  }
  return total;
}

it.skipIf(OUT === undefined || TEST_DATABASE_URL === undefined)(
  "times the players, redemptions and submissions export doors on a 100,000-player event",
  async () => {
    const f = await questifyFixture();
    try {
      const event = await seed(f);
      const [load] = await f.owner<{ load: string }>(
        "SELECT pg_size_pretty(pg_database_size(current_database())) AS load",
      );
      say(
        `seeded ${PLAYERS} players with one answer, redemption and submission each; db ${load?.load}`,
      );
      for (const door of DOORS) {
        const [shape] = await f.owner<{ args: number }>(
          "SELECT pronargs AS args FROM pg_proc WHERE proname = $1",
          [door],
        );
        const paged = shape?.args === 4;
        await walk(f, door, event, paged);
        const runs: Walk[] = [];
        for (let run = 0; run < 3; run += 1) runs.push(await walk(f, door, event, paged));
        runs.sort((a, b) => a.dbMs - b.dbMs);
        const m = runs[1] as Walk;
        say(
          `${door} (${paged ? `pages of ${PAGE}` : "whole"}): ${m.rows} rows, ${m.pages} calls, buffers ${m.buffers}, ` +
            `db ${m.dbMs.toFixed(0)} ms, walk ${m.wallMs.toFixed(0)} ms, largest answer ${(m.biggest / 1e6).toFixed(1)} MB; ` +
            `db ms of 3: ${runs.map((r) => r.dbMs.toFixed(0)).join(", ")}`,
        );
      }
    } finally {
      await f.close();
    }
  },
  900_000,
);
