import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  TEST_DATABASE_URL,
  createTestDatabase,
  seedTwoTenants,
  type TestDatabase,
} from "#test/support/test-db";

/**
 * T-804a part A (ADR-670, migration 0148): the completion path's LANGUAGE sql functions became plpgsql. The fixture
 * holds each function's attributes and CREATE statement as migration 0147 left them (taken from pg_get_functiondef).
 * plpgsql checks a body only when it runs, so every rewritten function is called here, and each answer is compared
 * with the old SQL body's on the same arguments (the old bodies are put back inside a transaction that is rolled back).
 */
type Original = Readonly<{
  name: string;
  args: string;
  owner: string;
  acl: string | null;
  securityDefiner: boolean;
  config: string[] | null;
  volatility: string;
  strict: boolean;
  parallel: string;
  returns: string;
  returnsSet: boolean;
  cost: number;
  rows: number;
  leakproof: boolean;
  definition: string;
}>;

const ORIGINALS: readonly Original[] = JSON.parse(
  readFileSync(join(import.meta.dirname, "hot-path-plpgsql.fixture.json"), "utf8"),
) as Original[];
const NAMES = ORIGINALS.map((original) => original.name);
/** Standard-body SQL functions on the path: kept as SQL with no SET clause, so they are inlined (migration 0148). */
const INLINED = [
  "event_day",
  "event_day_start",
  "event_multi_day",
  "questify_day",
  "questify_month",
  "streak_day_closed",
];

const ATTRIBUTES = `
  SELECT p.proname AS name, pg_get_function_identity_arguments(p.oid) AS args,
         pg_get_userbyid(p.proowner) AS owner, p.proacl::text AS acl, p.prosecdef AS "securityDefiner",
         p.proconfig AS config, p.provolatile AS volatility, p.proisstrict AS strict, p.proparallel AS parallel,
         pg_get_function_result(p.oid) AS returns, p.proretset AS "returnsSet", p.procost::float AS cost,
         p.prorows::float AS rows, p.proleakproof AS leakproof, l.lanname AS language
  FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
  WHERE p.pronamespace = 'public'::regnamespace AND p.proname = ANY($1) ORDER BY p.proname`;

type Ids = Readonly<{
  org: string;
  event: string;
  player: string;
  enrollment: string;
  quest: string;
  category: string;
  completion: string;
  xpEntry: string;
}>;
type Call = Readonly<{ name: string; sql: string; params: (ids: Ids) => unknown[] }>;

const QUEST = "(SELECT q FROM quest q WHERE q.id = $1)";
const MEMBER = "(SELECT n FROM enrollment n WHERE n.id = $2)";
const AT = "'2026-11-04 12:00+03'::timestamptz";
const scalar = (name: string, args: string, params: Call["params"] = () => []): Call => ({
  name,
  sql: `SELECT ${name}(${args}) AS v`,
  params,
});
const setOf = (name: string, args: string, params: Call["params"] = () => []): Call => ({
  name,
  sql: `SELECT * FROM ${name}(${args})`,
  params,
});
/** A composite as text: NULL when there is no row, `(,,)` for a row of NULLs, so the two cannot be confused. */
const composite = (name: string, args: string, params: Call["params"]): Call => ({
  name,
  sql: `SELECT ${name}(${args})::text AS v`,
  params,
});

const CALLS: readonly Call[] = [
  composite("boost_in_force", `$1, ${MEMBER}, ${AT}`, (i) => [i.category, i.enrollment]),
  composite("boost_in_force", `$1, ${MEMBER}, ${AT}`, (i) => [randomUUID(), i.enrollment]),
  scalar("category_community_lock", "$1", (i) => [i.category]),
  scalar("category_lock", `${QUEST}, $2`, (i) => [i.quest, i.enrollment]),
  scalar(
    "category_period_start",
    "(SELECT g FROM category g WHERE g.id = $1), (SELECT e FROM event e WHERE e.id = $2)",
    (i) => [i.category, i.event],
  ),
  scalar("completion_boost", "$1", (i) => [i.completion]),
  scalar("completion_boost", "-1"),
  scalar("daily_streak_on", ""),
  scalar("event_suspended", "$1", (i) => [i.event]),
  scalar("excluded_from_event", "$1, $2", (i) => [i.event, i.player]),
  setOf("flag_tuning", ""),
  composite("flag_tuning", "", () => []),
  scalar("is_review_demo_player", "$1", (i) => [i.player]),
  setOf("legal_in_force_rows", ""),
  scalar("legal_version_key", "'1.2'"),
  scalar("legal_version_key", "'3'"),
  setOf("level_title_of", "1::smallint"),
  setOf("level_title_of", "40::smallint"),
  scalar("levels_reach", "$1, $2, 0", (i) => [i.player, i.xpEntry]),
  scalar("levels_reach", "$1, $2, 100000000", (i) => [i.player, i.xpEntry]),
  setOf("organizer_team_players", "$1", (i) => [i.org]),
  setOf("own_bonus", "$1", (i) => [i.completion]),
  setOf("own_first_bonus", "$1", (i) => [i.completion]),
  setOf("own_level", "$1", (i) => [i.completion]),
  setOf("own_level", "-1"),
  setOf("own_quest_item", "$1", (i) => [i.completion]),
  setOf("own_streak_bonus", "$1", (i) => [i.completion]),
  scalar("period_count", `$2, ${QUEST}`, (i) => [i.quest, i.enrollment]),
  scalar("platform_tuning_int", "'flagBurstCount', 10, 3, 100"),
  scalar("platform_tuning_int", "'none', 7, 1, 9"),
  scalar("play_phase", `(SELECT e FROM event e WHERE e.id = $1), ${MEMBER}`, (i) => [
    i.event,
    i.enrollment,
  ]),
  scalar("player_legal_held", "$1", (i) => [i.player]),
  scalar("player_session_owner", "sha256('parity-access')"),
  scalar("player_session_owner", "sha256('no-such-token')"),
  composite("quest_boost", `${QUEST}, ${MEMBER}, ${AT}`, (i) => [i.quest, i.enrollment]),
  scalar("quest_community_lock", QUEST, (i) => [i.quest]),
  scalar("quest_xp", ""),
  setOf("ranking_day_entry_of", "$1", (i) => [i.completion]),
  scalar("ranking_eligible", "(SELECT n FROM enrollment n WHERE n.id = $1)", (i) => [i.enrollment]),
  setOf("ranking_entry_of", "$1", (i) => [i.completion]),
  setOf("ranking_entry_of", "-1"),
  scalar("reviewer_paid", "'submission', 'sub:1'"),
  scalar("reviewer_paid", "'qr', 'qr:1'"),
  scalar("system_paid", "'quiz', 'quiz:1'"),
  scalar("xp_level_of", "0"),
  scalar("xp_level_of", "100000000"),
  scalar("xp_month_of", "$1", (i) => [i.xpEntry]),
  scalar("xp_month_of", "-1"),
];

async function seed(owner: Client): Promise<Ids> {
  const tenants = await seedTwoTenants(owner);
  const one = async (sql: string, values: unknown[] = []): Promise<string> =>
    String((await owner.query<{ id: string }>(sql, values)).rows[0]?.id ?? "");
  const category = await one("SELECT id FROM category WHERE event_id = $1 LIMIT 1", [
    tenants.eventA,
  ]);
  const quest = await one(
    `INSERT INTO quest (event_id, category_id, type, title_en, points, type_config)
     VALUES ($1, $2, 'scan_qr', 'Parity quest', 50, '{}') RETURNING id`,
    [tenants.eventA, category],
  );
  await owner.query(
    `INSERT INTO boost (organizer_id, event_id, category_id, starts_at, ends_at)
     VALUES ($1, $2, $3, '2026-11-04 11:00+03', '2026-11-04 13:00+03')`,
    [tenants.orgA, tenants.eventA, category],
  );
  await owner.query(
    "SELECT issue_player_tokens($1, sha256('parity-access'), sha256('parity-refresh'), gen_random_uuid())",
    [tenants.playerA],
  );
  await owner.query("BEGIN");
  await owner.query("SELECT set_config('app.player_id', $1, true)", [tenants.playerA]);
  const completion = await one(
    "SELECT completion_id AS id FROM complete_quest($1, 'qr', 1, NULL, $2, NULL)",
    [quest, randomUUID()],
  );
  await owner.query("COMMIT");
  return {
    org: tenants.orgA,
    event: tenants.eventA,
    player: tenants.playerA,
    enrollment: await one("SELECT id FROM enrollment WHERE player_id = $1", [tenants.playerA]),
    quest,
    category,
    completion,
    xpEntry: await one("SELECT max(id) AS id FROM xp_entry WHERE player_id = $1", [
      tenants.playerA,
    ]),
  };
}

/** Runs every call as the seeded player in one transaction that is rolled back; also how often each function ran. */
async function answers(
  owner: Client,
  ids: Ids,
  restoreOld: boolean,
): Promise<{ answers: unknown[]; ran: Record<string, number> }> {
  await owner.query("BEGIN");
  try {
    if (restoreOld) {
      await owner.query(ORIGINALS.map((original) => original.definition).join(";\n"));
    }
    await owner.query("SELECT set_config('app.player_id', $1, true)", [ids.player]);
    const found: unknown[] = [];
    for (const call of CALLS) {
      found.push((await owner.query(call.sql, call.params(ids))).rows);
    }
    const { rows: ran } = await owner.query<{ name: string; calls: number }>(
      `SELECT p.proname AS name, coalesce(pg_stat_get_xact_function_calls(p.oid), 0)::int AS calls
       FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = ANY($1)`,
      [NAMES],
    );
    return { answers: found, ran: Object.fromEntries(ran.map((row) => [row.name, row.calls])) };
  } finally {
    await owner.query("ROLLBACK");
  }
}

describe.skipIf(TEST_DATABASE_URL === undefined)("hot path in plpgsql (T-804a, ADR-670)", () => {
  let db: TestDatabase;
  let ids: Ids;

  beforeAll(async () => {
    db = await createTestDatabase();
    await db.owner.query("SET track_functions = 'all'");
    ids = await seed(db.owner);
  });

  afterAll(async () => {
    await db.close();
  });

  it("keeps every attribute migration 0147 gave each function, and runs it as plpgsql", async () => {
    const { rows: now } = await db.owner.query<Record<string, unknown>>(ATTRIBUTES, [NAMES]);
    expect(now.map((row) => row["language"])).toEqual(NAMES.map(() => "plpgsql"));
    const withoutLanguage = now.map(({ language: _language, ...rest }) => rest);
    expect(withoutLanguage).toEqual(ORIGINALS.map(({ definition: _definition, ...rest }) => rest));
  });

  it("keeps the six standard-body functions in SQL with no setting, so the planner inlines them", async () => {
    const { rows: kept } = await db.owner.query<Record<string, unknown>>(
      `SELECT p.proname AS name, p.prosqlbody IS NOT NULL AS atomic, l.lanname AS language,
              p.prosecdef AS definer, p.proconfig AS config
       FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
       WHERE p.pronamespace = 'public'::regnamespace AND p.proname = ANY($1) ORDER BY p.proname`,
      [INLINED],
    );
    expect(kept).toEqual(
      INLINED.map((name) => ({
        name,
        atomic: true,
        language: "sql",
        definer: false,
        config: null,
      })),
    );
    const { rows: plan } = await db.owner.query<{ "QUERY PLAN": string }>(
      `EXPLAIN (VERBOSE, COSTS OFF)
       SELECT event_day(now(), e), event_multi_day(e), event_day_start(e, current_date), questify_month(now()),
              streak_day_closed(s, current_date)
       FROM event e CROSS JOIN event_streak s`,
    );
    const output = plan.map((row) => row["QUERY PLAN"]).join(" ");
    expect(output).toContain("make_interval");
    for (const name of INLINED) {
      expect(output).not.toContain(`${name}(`);
    }
  });

  it("calls every rewritten function directly, and each answers as the old SQL body did", async () => {
    expect([...new Set(CALLS.map((call) => call.name))].toSorted()).toEqual(NAMES);
    const plpgsql = await answers(db.owner, ids, false);
    const sql = await answers(db.owner, ids, true);
    expect(Object.entries(plpgsql.ran).filter(([, calls]) => calls === 0)).toEqual([]);
    expect(plpgsql.answers).toEqual(sql.answers);
  });

  it("answers NULL, not a row of NULLs, when no boost is in force", async () => {
    const { rows: found } = await db.owner.query<{ none: boolean }>(
      `SELECT boost_in_force($1, NULL::enrollment, now()) IS NULL
              AND (boost_in_force($1, NULL::enrollment, now()))::text IS NULL AS none`,
      [randomUUID()],
    );
    expect(found[0]?.none).toBe(true);
  });

  it("answers the completion's own parts with real values, so the comparison is not of empty sets", async () => {
    const plpgsql = await answers(db.owner, ids, false);
    const byName = (name: string) => plpgsql.answers[CALLS.findIndex((call) => call.name === name)];
    expect(byName("ranking_entry_of")).toEqual([
      expect.objectContaining({ enrollment_id: ids.enrollment, score: "50" }),
    ]);
    expect(byName("own_level")).toHaveLength(1);
    expect(byName("player_session_owner")).toEqual([{ v: ids.player }]);
  });
});
