import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Client } from "pg";
import { createClient } from "redis";
import { readInForce } from "#src/legal/in-force";
import { createQuestCodeKey, questCode } from "#src/quests/qr";
import { isLocalServer } from "#test/load/local-server";
import { qrSecret, required } from "#test/load/settings";
import { createTestDatabase } from "#test/support/test-db";

/**
 * Creates and fills the load test's database, or drops it (T-804, ops/load). Test code only.
 *
 * `create <plan.json>`: a fresh database named like the tests' ones (so a run that was killed is swept by the next test
 * run after two hours), every migration, then set-based SQL: organizers with one live event each, scan quests and one
 * probe quest per event (5,000 points, so its player leads the board), players with a phone, enrolled in one event
 * each. Sessions are issued by `issue_player_tokens`, the database function every API sign-in path ends in (migration
 * 0013), one statement for all players; the access token is base64url of a SHA-256 of a run seed, the format the API
 * reads. The plan file holds what the driver needs: tokens, signed quest codes, and the legal versions in force.
 *
 * `drop <database> <redis prefix>`: drops the database and deletes the run's Redis keys.
 *
 * Settings: TEST_DATABASE_URL (the admin URL), LOAD_REDIS_URL, LOAD_EVENTS, LOAD_PLAYERS (per event), LOAD_QUESTS,
 * LOAD_BIG_EVENT (players of event 1 when above 0, for a skewed seed).
 */
const NAME = /^questify_test_[0-9]{10}_[0-9a-f]{12}$/;
const PREFIX = /^load:[0-9a-f]{12}:$/;

/** `bigEvent`: when above 0, event 1 gets this many players instead of `players` (a skewed event, ADR-674). */
type Sizes = Readonly<{ events: number; players: number; quests: number; bigEvent: number }>;

const sizeOf = (name: string, fallback: number, least = 1): number => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < least) {
    throw new Error(
      `${name} must be a whole number of at least ${least}; got "${process.env[name]}".`,
    );
  }
  return value;
};

async function seedEvents(owner: Client, sizes: Sizes): Promise<void> {
  const q = (sql: string, values: unknown[] = []) => owner.query(sql, values);
  await q(
    `INSERT INTO organizer (name, slug) SELECT 'Load organizer ' || n, 'load-' || n FROM generate_series(1, $1) n`,
    [sizes.events],
  );
  await q(
    `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at)
     SELECT o.id, 'LOAD' || substr(o.slug, 6), 'Load event ' || substr(o.slug, 6), 'live',
            now() - interval '1 hour', now() + interval '1 day'
     FROM organizer o WHERE o.slug LIKE 'load-%'`,
  );
  await q(
    `INSERT INTO quest (event_id, category_id, type, title_en, points, repeat_cap, type_config)
     SELECT e.id, c.id, 'scan_qr', 'Load quest ' || n, 10 * (1 + n % 5), 1, '{}'
     FROM event e JOIN category c ON c.event_id = e.id CROSS JOIN generate_series(1, $1) n`,
    [sizes.quests],
  );
  await q(
    `INSERT INTO quest (event_id, category_id, type, title_en, points, repeat_cap, type_config)
     SELECT e.id, c.id, 'scan_qr', 'Load probe', 5000, 100, '{}' FROM event e JOIN category c ON c.event_id = e.id`,
  );
}

async function seedPlayers(owner: Client, sizes: Sizes, seed: string): Promise<void> {
  const q = (sql: string, values: unknown[] = []) => owner.query(sql, values);
  // Player n of event k is `ld<k>_<n>`; the probe of event k is `probe<k>`.
  await q(
    `INSERT INTO player (username)
     SELECT 'ld' || k || '_' || n
     FROM generate_series(1, $1) k CROSS JOIN LATERAL generate_series(1, CASE WHEN k = 1 AND $3 > 0 THEN $3 ELSE $2 END) n
     UNION ALL SELECT 'probe' || k FROM generate_series(1, $1) k`,
    [sizes.events, sizes.players, sizes.bigEvent],
  );
  await q(
    `INSERT INTO player_contact (player_id, phone_e164)
     SELECT id, '+9665' || lpad((row_number() OVER (ORDER BY username))::text, 8, '0') FROM player
     WHERE username ~ '^(ld|probe)[0-9]'`,
  );
  await q(
    `INSERT INTO enrollment (organizer_id, event_id, player_id)
     SELECT e.organizer_id, e.id, p.id FROM player p
     JOIN event e ON e.join_code = 'LOAD' || substring(p.username FROM '^(?:ld|probe)([0-9]+)')`,
  );
  await q(
    `WITH minted AS (
       SELECT id, rtrim(translate(encode(sha256(convert_to($1 || id::text, 'UTF8')), 'base64'), '+/', '-_'), '=') AS token
       FROM player WHERE username ~ '^(ld|probe)[0-9]'
     )
     SELECT count(issue_player_tokens(id, sha256(convert_to(token, 'UTF8')),
                                      sha256(convert_to('refresh.' || token, 'UTF8')), gen_random_uuid()))
     FROM minted`,
    [seed],
  );
  await q("ANALYZE");
}

type QuestRow = { event_id: string; id: string; title_en: string; qr_version: number };
type PlayerRow = { event_id: string; username: string; token: string };

async function planOf(owner: Client, seed: string) {
  const quests = await owner.query<QuestRow>(
    `SELECT q.event_id, q.id, q.title_en, q.qr_version FROM quest q JOIN event e ON e.id = q.event_id
     WHERE e.join_code LIKE 'LOAD%' ORDER BY e.join_code, q.title_en`,
  );
  const players = await owner.query<PlayerRow>(
    `SELECT n.event_id, p.username,
            rtrim(translate(encode(sha256(convert_to($1 || p.id::text, 'UTF8')), 'base64'), '+/', '-_'), '=') AS token
     FROM player p JOIN enrollment n ON n.player_id = p.id WHERE p.username ~ '^(ld|probe)[0-9]' ORDER BY p.username`,
    [seed],
  );
  const key = createQuestCodeKey(qrSecret());
  const events = new Map<
    string,
    { id: string; quests: object[]; probe: object; tokens: string[] }
  >();
  const eventOf = (id: string) => {
    const found = events.get(id) ?? { id, quests: [], probe: {}, tokens: [] };
    events.set(id, found);
    return found;
  };
  for (const row of quests.rows) {
    const quest = { id: row.id, code: questCode(key, row.id, row.qr_version) };
    if (row.title_en === "Load probe") {
      eventOf(row.event_id).probe = { ...eventOf(row.event_id).probe, quest };
    } else {
      eventOf(row.event_id).quests.push(quest);
    }
  }
  for (const row of players.rows) {
    const event = eventOf(row.event_id);
    if (row.username.startsWith("probe")) {
      event.probe = { ...event.probe, username: row.username, token: row.token };
    } else {
      event.tokens.push(row.token);
    }
  }
  return [...events.values()];
}

async function create(planFile: string): Promise<void> {
  // The tests' database helper runs roles.sql and sets the API role's password: only ever on this PC's server.
  if (!isLocalServer(required("TEST_DATABASE_URL"))) {
    throw new Error(
      "Refusing to seed TEST_DATABASE_URL: prepare create resets role passwords; local servers only.",
    );
  }
  const sizes = {
    events: sizeOf("LOAD_EVENTS", 10),
    players: sizeOf("LOAD_PLAYERS", 2500),
    quests: sizeOf("LOAD_QUESTS", 20),
    bigEvent: sizeOf("LOAD_BIG_EVENT", 0, 0),
  };
  const db = await createTestDatabase();
  const database = new URL(db.appUrl).pathname.slice(1);
  const seed = randomBytes(16).toString("hex");
  try {
    // Where PostgreSQL spends its time, per function, for the report (`count`); new connections pick it up.
    await db.owner.query(`ALTER DATABASE ${database} SET track_functions = 'all'`);
    await seedEvents(db.owner, sizes);
    await seedPlayers(db.owner, sizes, seed);
    const inForce = await readInForce(db.owner);
    const version = (document: string) =>
      inForce.find((row) => row.document === document)?.version ?? "1";
    const plan = {
      database,
      appUrl: db.appUrl,
      redisPrefix: `load:${randomBytes(6).toString("hex")}:`,
      sizes,
      accept: { terms: version("terms_of_use"), privacy: version("privacy_policy") },
      events: await planOf(db.owner, seed),
    };
    mkdirSync(dirname(planFile), { recursive: true });
    writeFileSync(planFile, JSON.stringify(plan));
  } catch (error) {
    await db.close();
    throw error;
  }
  process.stderr.write(`seeded ${database}: ${JSON.stringify(sizes)}\n`);
}

async function drop(database: string, prefix: string): Promise<void> {
  if (!NAME.test(database) || !PREFIX.test(prefix)) {
    throw new Error(`Refusing to drop "${database}" / "${prefix}": not a load test's names.`);
  }
  const admin = new Client({ connectionString: required("TEST_DATABASE_URL") });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
  } finally {
    await admin.end();
  }
  const redis = createClient({ url: required("LOAD_REDIS_URL") });
  await redis.connect();
  try {
    let deleted = 0;
    for await (const keys of redis.scanIterator({ MATCH: `${prefix}*`, COUNT: 1000 })) {
      if (keys.length > 0) {
        deleted += await redis.del(keys);
      }
    }
    process.stderr.write(`dropped ${database} and ${deleted} Redis keys\n`);
  } finally {
    await redis.close();
  }
}

/** Prints the completions, ledger entries and score total of the load events, to compare with the answers given. */
async function tally(database: string): Promise<void> {
  if (!NAME.test(database)) {
    throw new Error(`Refusing to read "${database}": not a load test's database.`);
  }
  const url = new URL(required("TEST_DATABASE_URL"));
  url.pathname = `/${database}`;
  const owner = new Client({ connectionString: url.toString() });
  await owner.connect();
  try {
    const { rows } = await owner.query(
      `SELECT (SELECT count(*)::int FROM quest_completion) AS completions,
              (SELECT count(*)::int FROM ledger_entry) AS ledger_entries,
              (SELECT coalesce(sum(score), 0)::bigint::text FROM enrollment) AS score_total,
              (SELECT coalesce(sum(q.points), 0)::bigint::text FROM quest_completion c JOIN quest q ON q.id = c.quest_id)
                AS completed_points`,
    );
    const functions = await owner.query(
      `SELECT funcname AS name, calls::int, round(self_time)::int AS self_ms, round(total_time)::int AS total_ms
       FROM pg_stat_user_functions ORDER BY self_time DESC LIMIT 15`,
    );
    process.stdout.write(`${JSON.stringify({ ...rows[0], topFunctions: functions.rows })}\n`);
  } finally {
    await owner.end();
  }
}

const [command, first, second] = process.argv.slice(2);
const work =
  command === "create" && first !== undefined
    ? create(first)
    : command === "count" && first !== undefined
      ? tally(first)
      : command === "drop" && first !== undefined && second !== undefined
        ? drop(first, second)
        : Promise.reject(
            new Error(
              "Usage: prepare create <plan.json> | count <database> | drop <database> <prefix>",
            ),
          );
// The tests' database helper keeps its admin connection open until `close`, which would drop the database: exit.
work.then(
  () => process.exit(0),
  (error: unknown) => {
    process.stderr.write(`prepare: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  },
);
