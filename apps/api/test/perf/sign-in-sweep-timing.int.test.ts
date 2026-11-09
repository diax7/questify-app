import { appendFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import type { Client } from "pg";
import { it } from "vitest";
import {
  TEST_DATABASE_URL,
  connectAsOwner,
  createTestDatabase,
  type TestDatabase,
} from "#test/support/test-db";

/**
 * The player sign-in sweep at 100,000 players (migration 0184, plan docs/plans/2026-11-09-sign-in-lock-order.md section
 * 5, plan review MAJOR-1). Steady state: 120,000 families (every fifth player on two devices), each rotating every 4 hours
 * on a random phase, with 7 days and 10 minutes of rotation history (about 5 million refresh rows and 5 million sessions,
 * written in the order they were made), 2,000 families ended over the week, and an hour and a half of codes. Prints:
 * 0155's sweep under the API's 5 s statement timeout (its indexes dropped in a rolled-back transaction), the per-row cost
 * of its foreign-key check, `EXPLAIN (ANALYZE, BUFFERS)` of every statement of one 0184 batch, and the API's batch loop
 * (each call its own transaction, until a call removes nothing or 1 s is spent) while rotations of the families it holds
 * run beside it, with each rotation's time. Gates: the run under 1 s, each batch under 250 ms, the longest rotation under
 * 250 ms. Also the indexes' write cost: rotations alone, p50 and p95, with and without them. The seed takes about 15
 * minutes, so more than one 10-minute slot has crossed the 7-day mark when it is measured (printed). Not an assertion: run it by hand when the sweep or its indexes change,
 * `SWEEP_TIMING=/path/to/out.txt pnpm vitest run apps/api/test/perf/sign-in-sweep-timing.int.test.ts`.
 */
const OUT = process.env["SWEEP_TIMING"];
const say = (line: string) => appendFileSync(String(OUT), `${line}\n`);
const ROTATORS = 6;
const BUDGET_MS = 1000;

const SEED = [
  "SET session_replication_role = replica",
  "INSERT INTO player (username) SELECT 'sw_' || g FROM generate_series(1, 100000) g",
  `CREATE TABLE sweep_fam AS
     SELECT p.id AS player_id, gen_random_uuid() AS family, random() AS phase
     FROM player p CROSS JOIN generate_series(1, 2) k
     WHERE p.username LIKE 'sw\\_%' AND (k = 1 OR right(p.username, 1) IN ('0', '5'))`,
  `INSERT INTO player_sign_in_device (player_id, family, platform, signed_in_at)
     SELECT player_id, family, 'ios', now() - interval '30 days' FROM sweep_fam`,
  // Rotation i of a family at start + (phase + i) * 4 h: row i is made then and used at rotation i + 1. Only what a
  // sweep 10 minutes ago left is written.
  `CREATE TABLE sweep_row AS
     SELECT f.player_id, f.family, i,
            now() - interval '7 days 10 minutes' + (f.phase + i) * interval '4 hours' AS made,
            now() - interval '7 days 10 minutes' + (f.phase + i + 1) * interval '4 hours' AS next
     FROM sweep_fam f CROSS JOIN generate_series(-1, 43) i
     WHERE now() - interval '7 days 10 minutes' + (f.phase + i) * interval '4 hours' < now()`,
  `INSERT INTO player_refresh (id, player_id, family, token_hash, created_at, expires_at, used_at, replaced_by,
                               family_started_at)
     SELECT md5(family::text || ':' || i)::uuid, player_id, family,
            sha256(convert_to(family::text || ':' || i, 'UTF8')), made, made + interval '180 days',
            CASE WHEN next < now() THEN next END,
            CASE WHEN next < now() THEN md5(family::text || ':' || (i + 1))::uuid END, now() - interval '30 days'
     FROM sweep_row
     WHERE CASE WHEN next < now() THEN next ELSE made + interval '180 days' END >= now() - interval '7 days 10 minutes'
     ORDER BY made`,
  `INSERT INTO player_session (player_id, token_hash, created_at, expires_at, revoked_at, refresh_family)
     SELECT player_id, sha256(convert_to('s:' || family::text || ':' || i, 'UTF8')), made, made + interval '1 hour',
            CASE WHEN next < now() THEN next END, family
     FROM sweep_row WHERE made + interval '1 hour' >= now() - interval '7 days 10 minutes' ORDER BY made`,
  `WITH ended AS (
     SELECT f.family, now() - interval '7 days 10 minutes' + (f.g % 1000) * interval '10 minutes 5 seconds' AS at
     FROM (SELECT family, row_number() OVER (ORDER BY family) AS g FROM sweep_fam ORDER BY family LIMIT 2000) f)
   UPDATE player_sign_in_device d SET ended_at = e.at FROM ended e WHERE d.family = e.family`,
  `UPDATE player_refresh r SET revoked_at = greatest(d.ended_at, r.created_at)
     FROM player_sign_in_device d WHERE d.family = r.family AND d.ended_at IS NOT NULL AND r.used_at IS NULL`,
  `UPDATE player_session s SET revoked_at = greatest(d.ended_at, s.created_at)
     FROM player_sign_in_device d
     WHERE d.family = s.refresh_family AND d.ended_at IS NOT NULL AND s.revoked_at IS NULL`,
  `INSERT INTO player_login_challenge (id, token_hash, channel, contact, contact_key, code_hash, expires_at,
                                       terms_version, privacy_version, contact_fp, last_sent_at)
     SELECT gen_random_uuid(), sha256(convert_to('l' || g, 'UTF8')), 'phone', '+9665' || lpad(g::text, 8, '0'),
            sha256(convert_to('k' || g, 'UTF8')), sha256(convert_to('c' || g, 'UTF8')),
            now() - interval '85 minutes' + g * interval '1 second', '1.0', '1.0',
            sha256(convert_to('f' || g, 'UTF8')), now() - interval '90 minutes' + g * interval '1 second'
     FROM generate_series(1, 5400) g`,
  `INSERT INTO player_contact_challenge (id, player_id, token_hash, channel, contact, code_hash, expires_at, contact_fp)
     SELECT gen_random_uuid(), f.player_id, sha256(convert_to('cc' || f.family::text, 'UTF8')), 'email',
            'x' || left(f.family::text, 8) || '@example.com', sha256(convert_to('c', 'UTF8')),
            now() - interval '85 minutes' + (row_number() OVER ()) * interval '10 seconds',
            sha256(convert_to('f', 'UTF8'))
     FROM (SELECT DISTINCT ON (player_id) player_id, family FROM sweep_fam ORDER BY player_id LIMIT 540) f`,
  `INSERT INTO player_reauth_challenge (player_id, family, token_hash, channel, code_hash, expires_at)
     SELECT f.player_id, f.family, sha256(convert_to('ra' || f.family::text, 'UTF8')), 'phone',
            sha256(convert_to('c', 'UTF8')),
            now() - interval '85 minutes' + (row_number() OVER ()) * interval '10 seconds'
     FROM (SELECT player_id, family FROM sweep_fam ORDER BY family DESC LIMIT 540) f`,
  "DROP TABLE sweep_row",
  "DROP TABLE sweep_fam",
  "SET session_replication_role = origin",
  "VACUUM ANALYZE",
];

// 0155's body, as it ran before 0184 (for the "before" number only; created and dropped in a rolled-back transaction).
const SWEEP_0155 = `CREATE FUNCTION sweep_0155() RETURNS void LANGUAGE sql AS $$
  DELETE FROM player_login_challenge
  WHERE greatest(expires_at, coalesce(signup_expires_at, expires_at)) < now() - interval '1 hour';
  DELETE FROM player_contact_challenge WHERE expires_at < now() - interval '1 hour';
  DELETE FROM player_reauth_challenge WHERE expires_at < now() - interval '1 hour';
  DELETE FROM player_session
  WHERE (revoked_at IS NOT NULL AND revoked_at < now() - interval '7 days') OR expires_at < now() - interval '7 days';
  UPDATE player_refresh SET replaced_by = NULL
  WHERE replaced_by IN (SELECT id FROM player_refresh
                        WHERE (revoked_at IS NOT NULL AND revoked_at < now() - interval '7 days')
                           OR (used_at IS NOT NULL AND used_at < now() - interval '7 days')
                           OR expires_at < now() - interval '7 days');
  DELETE FROM player_refresh
  WHERE (revoked_at IS NOT NULL AND revoked_at < now() - interval '7 days')
     OR (used_at IS NOT NULL AND used_at < now() - interval '7 days')
     OR expires_at < now() - interval '7 days';
  DELETE FROM player_sign_in_device d
  WHERE d.ended_at < now() - interval '7 days'
     OR NOT EXISTS (SELECT 1 FROM player_refresh r WHERE r.family = d.family);
$$`;
const SWEEP_INDEXES = [
  "player_refresh_sweep_idx",
  "player_refresh_replaced_by_idx",
  "player_session_sweep_idx",
  "player_session_sweep_orphan_idx",
  "player_sign_in_device_ended_idx",
];

async function counts(db: TestDatabase): Promise<string> {
  const { rows } = await db.owner.query<Record<string, string>>(
    `SELECT (SELECT count(*) FROM player_refresh) AS refresh, (SELECT count(*) FROM player_session) AS sessions,
            (SELECT count(*) FROM player_refresh
             WHERE least(revoked_at, used_at, expires_at) < now() - interval '7 days') AS old_refresh,
            (SELECT count(*) FROM player_session
             WHERE least(revoked_at, expires_at) < now() - interval '7 days') AS old_sessions,
            (SELECT count(*) FROM player_sign_in_device WHERE ended_at < now() - interval '7 days') AS old_devices`,
  );
  return JSON.stringify(rows[0]);
}

/** 0155's sweep under the statement timeout, and its foreign-key check's cost per deleted row. Rolled back. */
async function before(db: TestDatabase): Promise<void> {
  const q = (sql: string) => db.owner.query(sql);
  await q("BEGIN");
  try {
    for (const name of SWEEP_INDEXES) await q(`DROP INDEX ${name}`);
    await q(SWEEP_0155);
    const plan = await q(
      `EXPLAIN (ANALYZE, BUFFERS) DELETE FROM player_refresh WHERE id IN (
         SELECT id FROM player_refresh WHERE used_at < now() - interval '7 days' LIMIT 20)`,
    );
    for (const row of plan.rows) say(`  ${String(row["QUERY PLAN"])}`);
    await q("SAVEPOINT run");
    await q("SET LOCAL statement_timeout = 5000");
    const began = performance.now();
    try {
      await q("SELECT sweep_0155()");
      say(`0155 sweep: ${Math.round(performance.now() - began)} ms`);
    } catch (error) {
      say(
        `0155 sweep: stopped by the 5 s statement timeout after ${Math.round(performance.now() - began)} ms (${String(error)})`,
      );
    }
  } finally {
    await q("ROLLBACK");
  }
}

/** Every statement of one 0184 batch, with its plan. Rolled back. */
async function explainBatch(db: TestDatabase): Promise<void> {
  const lines: string[] = [];
  const listen = (message: { message?: string | undefined }) => lines.push(String(message.message));
  db.owner.on("notice", listen);
  try {
    for (const sql of [
      "LOAD 'auto_explain'",
      "SET auto_explain.log_min_duration = 0",
      "SET auto_explain.log_analyze = on",
      "SET auto_explain.log_buffers = on",
      "SET auto_explain.log_nested_statements = on",
      "SET auto_explain.log_level = notice",
      "BEGIN",
      "SELECT sweep_player_sign_in()",
      "ROLLBACK",
      "SET auto_explain.log_min_duration = -1",
    ]) {
      await db.owner.query(sql);
    }
  } finally {
    db.owner.off("notice", listen);
  }
  // The foreign key's checks run once a deleted row; print them once, with their count.
  const checks = lines.filter((line) => line.includes('FROM ONLY "public"'));
  for (const line of lines.filter((l) => !l.includes('FROM ONLY "public"'))) say(line);
  say(`(${checks.length} foreign-key check plans left out, each like:)`);
  if (checks[0] !== undefined) say(checks[0]);
}

type Rotation = { ms: number; outcome: string };

const WRITES = 1000;

/** p50 and p95 of a list of times, in ms. */
function percentiles(ms: number[]): string {
  const sorted = ms.toSorted((a, b) => a - b);
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
  return `p50 ${at(0.5).toFixed(2)} ms, p95 ${at(0.95).toFixed(2)} ms`;
}

/**
 * The indexes' write cost on the hot path (code review MINOR-5): rotations alone (no sweep), each a new refresh row and
 * session and the used one updated, with 0184's indexes and with them dropped, each set in a rolled-back transaction on
 * one connection (as `before` does for 0155). A warm-up set first, so both sets read a warm cache.
 */
async function writeCost(db: TestDatabase): Promise<void> {
  const { rows } = await db.owner.query<{ token_hash: Buffer }>(
    `SELECT token_hash FROM player_refresh WHERE used_at IS NULL AND revoked_at IS NULL ORDER BY random() LIMIT $1`,
    [3 * WRITES],
  );
  const live = rows.map((row) => row.token_hash);
  const client = await connectAsOwner(db);
  const timed = async (tokens: Buffer[], drop: boolean): Promise<number[]> => {
    await client.query("BEGIN");
    try {
      if (drop) for (const name of SWEEP_INDEXES) await client.query(`DROP INDEX ${name}`);
      const seen: number[] = [];
      for (const presented of tokens) {
        const began = performance.now();
        await client.query("SELECT outcome FROM rotate_player_refresh($1, $2, $3)", [
          presented,
          randomBytes(32),
          randomBytes(32),
        ]);
        seen.push(performance.now() - began);
      }
      return seen;
    } finally {
      await client.query("ROLLBACK");
    }
  };
  try {
    await timed(live.slice(0, WRITES), false);
    const without = await timed(live.slice(WRITES, 2 * WRITES), true);
    const withIndexes = await timed(live.slice(2 * WRITES), false);
    say(`rotations alone (${WRITES} each), with 0184's indexes: ${percentiles(withIndexes)}`);
    say(`rotations alone (${WRITES} each), without them: ${percentiles(without)}`);
  } finally {
    await client.end();
  }
}

/** Rotates the families' live tokens one after another on its own connection until `done` says stop. */
async function rotator(client: Client, live: Buffer[], done: () => boolean): Promise<Rotation[]> {
  const seen: Rotation[] = [];
  while (!done() && live.length > 0) {
    const presented = live.pop();
    const began = performance.now();
    const { rows } = await client.query<{ outcome: string }>(
      "SELECT outcome FROM rotate_player_refresh($1, $2, $3)",
      [presented, randomBytes(32), randomBytes(32)],
    );
    seen.push({ ms: performance.now() - began, outcome: rows[0]?.outcome ?? "" });
  }
  return seen;
}

/** The API's loop (sweepIfDue) with rotations of the old families beside it; prints each batch and the rotations. */
async function crossing(db: TestDatabase): Promise<void> {
  const { rows: tokens } = await db.owner.query<{ token_hash: Buffer }>(
    `SELECT r.token_hash FROM player_refresh r
     WHERE r.used_at IS NULL AND r.revoked_at IS NULL AND r.family IN (
       SELECT o.family FROM player_refresh o WHERE least(o.revoked_at, o.used_at, o.expires_at) < now() - interval '7 days')
     ORDER BY random()`,
  );
  const live = tokens.map((row) => row.token_hash);
  const clients = await Promise.all(Array.from({ length: ROTATORS }, () => connectAsOwner(db)));
  try {
    const alone = await rotator(clients[0] as Client, live.splice(0, 200), () => false);
    say(`rotations alone (200): longest ${Math.round(Math.max(...alone.map((r) => r.ms)))} ms`);
    let finished = false;
    const beside = Promise.all(clients.map((client) => rotator(client, live, () => finished)));
    const batches: { ms: number; removed: number }[] = [];
    const began = performance.now();
    // As sweepIfDue: a batch starts only when one more as long as the last still ends inside the budget.
    let last = 0;
    for (let removed = 1; removed > 0 && performance.now() - began + last < BUDGET_MS;) {
      const one = performance.now();
      const { rows } = await db.owner.query<{ removed: number }>(
        "SELECT sweep_player_sign_in() AS removed",
      );
      removed = rows[0]?.removed ?? 0;
      last = performance.now() - one;
      batches.push({ ms: last, removed });
    }
    const run = performance.now() - began;
    finished = true;
    const rotations = (await beside).flat();
    say(
      `0184 run: ${Math.round(run)} ms, ${batches.length} batches, ` +
        `${batches.reduce((sum, b) => sum + b.removed, 0)} rows; batches (ms/rows): ` +
        batches.map((b) => `${Math.round(b.ms)}/${b.removed}`).join(" "),
    );
    const outcomes = new Map<string, number>();
    for (const r of rotations) outcomes.set(r.outcome, (outcomes.get(r.outcome) ?? 0) + 1);
    const sorted = rotations.map((r) => r.ms).toSorted((a, b) => a - b);
    say(
      `rotations beside it: ${rotations.length} (${[...outcomes].map(([k, v]) => `${k} ${v}`).join(", ")}), ` +
        `median ${Math.round(sorted[Math.floor(sorted.length / 2)] ?? 0)} ms, longest ${Math.round(sorted.at(-1) ?? 0)} ms`,
    );
  } finally {
    await Promise.all(clients.map((client) => client.end()));
  }
}

it.skipIf(OUT === undefined || TEST_DATABASE_URL === undefined)(
  "times the sign-in sweep at 100,000 players, before and after 0184, and the rotations that cross it",
  async () => {
    const db = await createTestDatabase();
    try {
      const seeded = performance.now();
      for (const sql of SEED) await db.owner.query(sql);
      say(`seeded in ${Math.round((performance.now() - seeded) / 1000)} s: ${await counts(db)}`);
      await before(db);
      await explainBatch(db);
      await writeCost(db);
      await crossing(db);
      say(`after the run: ${await counts(db)}`);
    } finally {
      await db.close();
    }
  },
  3_600_000,
);
