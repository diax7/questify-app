import { appendFileSync } from "node:fs";
import { it } from "vitest";
import { questifyFixture, type QuestifyFixture } from "#test/support/questify";
import { TEST_DATABASE_URL } from "#test/support/test-db";

/**
 * The page reads of the players and redemptions exports (migrations 0182, 0183) on a seeded set: an event of 20,000
 * members, each with a reward redemption, and rank-prize redemptions (no reward, so outside the file) for one member in
 * `EXPORT_INDEX_OTHERS` (1 by default), beside a second event of the same size. Prints `EXPLAIN (ANALYZE, BUFFERS)` of
 * each door's page query, as the door runs it, for the first page and one from the middle, the size of each index the
 * plans name, and what the players' index adds to a score update. Not an assertion: run it by hand when the doors or
 * their indexes change, `EXPORT_INDEX_PLANS=/path/to/out.txt pnpm vitest run
 * apps/api/test/perf/export-index-plans.int.test.ts`.
 */
const OUT = process.env["EXPORT_INDEX_PLANS"];
const say = (line: string) => appendFileSync(String(OUT), `${line}\n`);
const PLAYERS = 20_000;
const PAGE = 5000;
const OTHER_EVERY = Number(process.env["EXPORT_INDEX_OTHERS"] ?? "1");

async function seedEvent(f: QuestifyFixture, tag: string): Promise<string> {
  const event = await f.newEvent({ phase: "live" });
  const q = (sql: string, values: unknown[] = []) => f.db.owner.query(sql, values);
  await q(
    `INSERT INTO reward (event_id, kind, name_en, price, stock_total, units_out, position)
     VALUES ($1, 'experience', 'Reward', 50, 100000, 0, 0)`,
    [event],
  );
  await q("BEGIN");
  await q("SET LOCAL session_replication_role = replica");
  await q("INSERT INTO player (username) SELECT $2 || n FROM generate_series(1, $1) n", [
    PLAYERS,
    tag,
  ]);
  await q(
    `INSERT INTO enrollment (organizer_id, event_id, player_id, joined_at, score, balance)
     SELECT e.organizer_id, e.id, p.id, now() - (row_number() OVER (ORDER BY p.id) / 10) * interval '1 second',
            0, 0
     FROM event e CROSS JOIN player p WHERE e.id = $1 AND p.username LIKE $2 || '%'`,
    [event, tag],
  );
  // A reward redemption per member, then a rank prize for one member in OTHER_EVERY (reward_id NULL; its foreign key
  // is off here).
  await q(
    `INSERT INTO redemption (organizer_id, event_id, enrollment_id, reward_id, price, status, idempotency_key,
                             reserved_until, created_at)
     SELECT n.organizer_id, n.event_id, n.id, r.id, 50, 'reserved', gen_random_uuid()::text, now() + interval '1 day',
            n.joined_at + interval '1 minute'
     FROM enrollment n JOIN reward r ON r.event_id = n.event_id WHERE n.event_id = $1`,
    [event],
  );
  await q(
    `INSERT INTO redemption (organizer_id, event_id, enrollment_id, rank_prize_id, price, status, idempotency_key,
                             reserved_until, created_at)
     SELECT n.organizer_id, n.event_id, n.id, gen_random_uuid(), 0, 'reserved', gen_random_uuid()::text,
            now() + interval '1 day', n.joined_at + interval '2 minutes'
     FROM enrollment n WHERE n.event_id = $1 AND get_byte(uuid_send(n.id), 15) % $2 = 0`,
    [event, OTHER_EVERY],
  );
  await q("COMMIT");
  return event;
}

const PLAYERS_PAGE = `SELECT n.id, n.joined_at, n.player_id, n.status, n.score FROM enrollment n
  WHERE n.event_id = $1 AND n.status NOT IN ('pending', 'declined') AND (n.joined_at, n.id) > ($2, $3::uuid)
  ORDER BY n.joined_at, n.id LIMIT ${PAGE}`;
const REDEMPTIONS_PAGE = `SELECT r.id, r.created_at, r.ended_at, r.reward_id, r.enrollment_id, r.price, r.status
  FROM redemption r
  WHERE r.event_id = $1 AND r.reward_id IS NOT NULL AND (r.created_at, r.id) > ($2, $3::uuid)
  ORDER BY r.created_at, r.id LIMIT ${PAGE}`;

async function explain(f: QuestifyFixture, name: string, sql: string, values: unknown[]) {
  // A prepared statement with values, as the door's PL/pgSQL runs it; a generic plan is what a door reaches after
  // five calls on one connection, so both are printed.
  for (const mode of ["force_custom_plan", "force_generic_plan"]) {
    await f.owner(`SET plan_cache_mode = ${mode}`);
    const rows = await f.owner(`EXPLAIN (ANALYZE, BUFFERS) ${sql}`, values);
    say(`--- ${name}, ${mode}`);
    for (const row of rows) say(String(row["QUERY PLAN"]));
  }
  await f.owner("RESET plan_cache_mode");
}

const median = (values: number[]) =>
  values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
const list = (values: number[] = []) => values.map((t) => t.toFixed(1)).join(", ");

/**
 * What `enrollment_event_joined_idx` adds to a completion's score update (already not HOT, through
 * `enrollment_ranking_idx`), triggers off so only the row and its index entries are timed, with and without the index
 * in turns, 6 rounds each: 2,000 one-row updates of score and balance each in its own transaction, as a completion is
 * (the commit's WAL flush included), then 2,000 in one server-side loop (the row and index work alone).
 */
async function timeScoreUpdates(f: QuestifyFixture, event: string) {
  const ids = (
    await f.owner<{ id: string }>(
      "SELECT id::text FROM enrollment WHERE event_id = $1 ORDER BY id LIMIT 2000",
      [event],
    )
  ).map((row) => row.id);
  const update = "UPDATE enrollment SET score = score + 1, balance = balance + 1 WHERE id = $1";
  const loop = `DO $$ DECLARE i uuid; BEGIN
    FOR i IN SELECT id FROM enrollment WHERE event_id = '${event}'::uuid ORDER BY id LIMIT 2000 LOOP
      UPDATE enrollment SET score = score + 1, balance = balance + 1 WHERE id = i;
    END LOOP; END $$`;
  await f.owner("SET session_replication_role = replica");
  const times = { with: [[], []], without: [[], []] } as Record<"with" | "without", number[][]>;
  for (let round = 0; round < 12; round += 1) {
    const variant = round % 2 === 0 ? "without" : "with";
    await f.owner(
      variant === "with"
        ? "CREATE INDEX enrollment_event_joined_idx ON enrollment (event_id, joined_at, id)"
        : "DROP INDEX enrollment_event_joined_idx",
    );
    await f.owner("VACUUM ANALYZE enrollment");
    let started = performance.now();
    for (const id of ids) await f.owner(update, [id]);
    times[variant][0]?.push(((performance.now() - started) / ids.length) * 1000);
    await f.owner("VACUUM ANALYZE enrollment");
    started = performance.now();
    await f.owner(loop);
    times[variant][1]?.push(((performance.now() - started) / ids.length) * 1000);
  }
  await f.owner("RESET session_replication_role");
  for (const [n, name] of ["a transaction each", "one loop"].entries()) {
    say(
      `score update, ${name}, us a row (median of 6, each the mean of ${ids.length}): without the index ` +
        `${median(times.without[n] ?? []).toFixed(1)}, with ${median(times.with[n] ?? []).toFixed(1)}; ` +
        `without ${list(times.without[n])}; with ${list(times.with[n])}`,
    );
  }
}

it.skipIf(OUT === undefined || TEST_DATABASE_URL === undefined)(
  "prints the export page plans and index sizes on a seeded set",
  async () => {
    const f = await questifyFixture();
    try {
      const event = await seedEvent(f, "xa_");
      await seedEvent(f, "xb_");
      await f.owner("VACUUM ANALYZE enrollment");
      await f.owner("VACUUM ANALYZE redemption");
      const [mid] = await f.owner<{ at: string; id: string }>(
        `SELECT created_at::text AS at, id::text FROM redemption WHERE event_id = $1 AND reward_id IS NOT NULL
         ORDER BY created_at, id OFFSET ${PLAYERS / 2} LIMIT 1`,
        [event],
      );
      const [midJoin] = await f.owner<{ at: string; id: string }>(
        `SELECT joined_at::text AS at, id::text FROM enrollment WHERE event_id = $1
         ORDER BY joined_at, id OFFSET ${PLAYERS / 2} LIMIT 1`,
        [event],
      );
      const zero = "00000000-0000-0000-0000-000000000000";
      await explain(f, "redemptions, first page", REDEMPTIONS_PAGE, [event, "-infinity", zero]);
      await explain(f, "redemptions, middle page", REDEMPTIONS_PAGE, [event, mid?.at, mid?.id]);
      await explain(f, "players, first page", PLAYERS_PAGE, [event, "-infinity", zero]);
      await explain(f, "players, middle page", PLAYERS_PAGE, [event, midJoin?.at, midJoin?.id]);
      const sizes = await f.owner<{ name: string; size: string; def: string }>(
        `SELECT c.relname AS name, pg_size_pretty(pg_relation_size(c.oid)) AS size, pg_get_indexdef(c.oid) AS def
         FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
         WHERE i.indrelid IN ('redemption'::regclass, 'enrollment'::regclass) ORDER BY c.relname`,
      );
      for (const row of sizes) say(`${row.name} ${row.size}: ${row.def}`);
      await timeScoreUpdates(f, event);
    } finally {
      await f.close();
    }
  },
  900_000,
);
