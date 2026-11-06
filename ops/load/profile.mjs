// The one-at-a-time completion profile (T-804e, ADR-674): `node ops/load/profile.mjs [options]`; docs/RUNBOOK.md
// "Profiling the completion path". Seeds a throw-away database with the load test's seed, starts one load API and
// sends QR completions one after another over HTTP. It reports the client's latency, the database time a completion
// from `pg_stat_user_functions` (the seed turns `track_functions` on), and then, on one superuser connection with
// auto_explain loaded for that session only, the statements and triggers of `complete_quest_answer` by time. It needs
// no extension, so it runs on the shared test container. The database and the run's Redis keys are dropped after.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createClient, playerHeaders } from "./http.mjs";
import { build, checkDisk, pg, prepare, requireLoopback, ROOT, say, startApi } from "./local.mjs";
import { functionsPerCompletion, parseExplain, statementsPerCompletion } from "./profile-stats.mjs";
import { summarize } from "./stats.mjs";

const { values: opt } = parseArgs({
  options: {
    events: { type: "string", default: "10" },
    players: { type: "string", default: "2500" },
    quests: { type: "string", default: "20" },
    "big-event-players": { type: "string", default: "0" },
    // Completions each player makes in a row (1: every completion is a player's first, as T-804a measured).
    "quests-per-player": { type: "string", default: "1" },
    warmup: { type: "string", default: "300" },
    completions: { type: "string", default: "2000" },
    // A pause between completions; 100 makes about 10 a second, the rate of T-804c's low-rate measure (Q-641).
    "gap-ms": { type: "string", default: "0" },
    "explain-warmup": { type: "string", default: "30" },
    explain: { type: "string", default: "200" },
    "pool-size": { type: "string", default: "10" },
    port: { type: "string", default: "4830" },
    "admin-url": {
      type: "string",
      default:
        process.env["TEST_DATABASE_URL"] ?? "postgres://postgres:postgres@127.0.0.1:55432/postgres",
    },
    "redis-url": {
      type: "string",
      default: process.env["TEST_REDIS_URL"] ?? "redis://127.0.0.1:56379",
    },
  },
});
const num = (/** @type {string} */ name) => {
  const value = Number(opt[name]);
  if (!(Number.isInteger(value) && value >= 0))
    throw new Error(`--${name} must be a whole number; got "${opt[name]}".`);
  return value;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// A backend flushes its function statistics within about 10 s of going idle (PostgreSQL's idle stats interval).
const STATS_FLUSH_MS = 11_000;

const settings = () => ({
  TEST_DATABASE_URL: opt["admin-url"],
  LOAD_REDIS_URL: opt["redis-url"],
  LOAD_EVENTS: opt.events,
  LOAD_PLAYERS: opt.players,
  LOAD_QUESTS: opt.quests,
  LOAD_BIG_EVENT: opt["big-event-players"],
});

const runDatabaseUrl = (database) => {
  const url = new URL(opt["admin-url"]);
  url.pathname = `/${database}`;
  return url.toString();
};

/** Completion `index` of the run: events in turn; in each event, players in turn, each doing `perPlayer` quests. */
function pairOf(plan, index, perPlayer) {
  const event = plan.events[index % plan.events.length];
  const nth = Math.floor(index / plan.events.length);
  const player = Math.floor(nth / perPlayer);
  if (player >= event.tokens.length) throw new Error("The seed has too few players for the run.");
  return { event, token: event.tokens[player], quest: event.quests[nth % perPlayer] };
}

/** Sends completions `from` to `to - 1` one at a time; their latencies in ms and their answers by status. */
async function sendInTurn(client, plan, range) {
  const latencies = [];
  const statuses = {};
  for (let index = range.from; index < range.to; index += 1) {
    const { token, quest } = pairOf(plan, index, num("quests-per-player"));
    const started = performance.now();
    const answer = await client.send(
      "POST",
      `/v1/quests/${quest.id}/complete`,
      playerHeaders(token),
      {
        proof: { type: "qr", code: quest.code },
      },
    );
    latencies.push(performance.now() - started);
    statuses[answer.status] = (statuses[answer.status] ?? 0) + 1;
    if (num("gap-ms") > 0) await sleep(num("gap-ms"));
  }
  return { latencies, statuses };
}

async function functionStats(owner) {
  await owner.query("SELECT pg_stat_clear_snapshot()");
  const { rows } = await owner.query(
    `SELECT funcname AS name, calls::int, total_time AS total, self_time AS self FROM pg_stat_user_functions`,
  );
  return rows.map((row) => ({ ...row, total: Number(row.total), self: Number(row.self) }));
}

/** The HTTP phase: warm-up, then the measured completions between two snapshots of the function statistics. */
async function httpPhase(plan, owner) {
  const client = createClient(`http://127.0.0.1:${num("port")}`, 1);
  try {
    const warm = await sendInTurn(client, plan, { from: 0, to: num("warmup") });
    await sleep(STATS_FLUSH_MS);
    const before = await functionStats(owner);
    const started = performance.now();
    const measured = await sendInTurn(client, plan, {
      from: num("warmup"),
      to: num("warmup") + num("completions"),
    });
    const seconds = (performance.now() - started) / 1000;
    await sleep(STATS_FLUSH_MS);
    const functions = functionsPerCompletion(
      before,
      await functionStats(owner),
      num("completions"),
    );
    const at = (name) => functions.find((row) => row.name === name)?.totalMs ?? 0;
    return {
      warmupStatuses: warm.statuses,
      statuses: measured.statuses,
      perSecond: Math.round((num("completions") / seconds) * 10) / 10,
      clientMs: summarize(measured.latencies),
      databaseMsPerCompletion:
        Math.round((at("complete_quest_answer") + at("player_request_gate")) * 100) / 100,
      functions: functions.slice(0, 40),
    };
  } finally {
    client.close();
  }
}

/** Players who have completed nothing yet and the quests each will complete, for the explain phase. */
async function freshPairs(owner, count) {
  const perPlayer = num("quests-per-player");
  const { rows } = await owner.query(
    `SELECT n.player_id, q.ids, q.versions FROM enrollment n JOIN player p ON p.id = n.player_id
     CROSS JOIN LATERAL (
       SELECT array_agg(id ORDER BY title_en) AS ids, array_agg(qr_version ORDER BY title_en) AS versions
       FROM (SELECT id, title_en, qr_version FROM quest
             WHERE event_id = n.event_id AND title_en <> 'Load probe' ORDER BY title_en LIMIT $2) chosen
     ) q
     WHERE p.username LIKE 'ld%' AND NOT EXISTS (SELECT 1 FROM quest_completion c WHERE c.enrollment_id = n.id)
     ORDER BY p.username DESC LIMIT $1`,
    [Math.ceil(count / perPlayer), perPlayer],
  );
  return rows
    .flatMap((row) =>
      row.ids.map((id, i) => ({ player: row.player_id, quest: id, version: row.versions[i] })),
    )
    .slice(0, count);
}

const EXPLAIN_SETTINGS = [
  "LOAD 'auto_explain'",
  "SET auto_explain.log_min_duration = 0",
  "SET auto_explain.log_analyze = on",
  "SET auto_explain.log_timing = on",
  "SET auto_explain.log_triggers = on",
  "SET auto_explain.log_nested_statements = on",
  "SET auto_explain.log_format = 'json'",
  "SET auto_explain.log_level = 'notice'",
];

/** The explain phase: the engine called as the API calls it, with every nested statement's plan sent back as a notice. */
async function explainPhase(database) {
  const { Client } = pg();
  const client = new Client({ connectionString: runDatabaseUrl(database) });
  await client.connect();
  try {
    const wanted = num("explain-warmup") + num("explain");
    const pairs = await freshPairs(client, wanted);
    if (pairs.length < wanted)
      throw new Error(
        `The seed has ${pairs.length} fresh pairs for ${wanted} explained completions.`,
      );
    for (const sql of EXPLAIN_SETTINGS) await client.query(sql);
    // The API's role, so row-level security and grants are those of a real completion; auto_explain stays loaded.
    await client.query("SET ROLE questify_app");
    const plans = [];
    let recording = false;
    client.on("notice", (notice) => {
      const parsed = recording ? parseExplain(notice.message ?? "") : null;
      if (parsed !== null) plans.push(parsed);
    });
    const engineMs = [];
    for (const [i, pair] of pairs.entries()) {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.player_id', $1, true)", [pair.player]);
      recording = i >= num("explain-warmup");
      const started = performance.now();
      await client.query(
        "SELECT * FROM complete_quest_answer($1, 'qr', $2, NULL, $3, NULL, NULL)",
        [pair.quest, pair.version, randomUUID()],
      );
      if (recording) engineMs.push(performance.now() - started);
      recording = false;
      await client.query("COMMIT");
    }
    return { clientMs: summarize(engineMs), ...statementsPerCompletion(plans, engineMs.length) };
  } finally {
    await client.end();
  }
}

async function profile(plan) {
  const { Client } = pg();
  const owner = new Client({ connectionString: runDatabaseUrl(plan.database) });
  await owner.connect();
  try {
    const http = await httpPhase(plan, owner);
    return { http, explain: num("explain") > 0 ? await explainPhase(plan.database) : null };
  } finally {
    await owner.end();
  }
}

async function main() {
  const dir = join(
    ROOT,
    "ops",
    "load",
    "out",
    `profile-${new Date().toISOString().replaceAll(":", "-")}`,
  );
  requireLoopback(opt);
  mkdirSync(dir, { recursive: true });
  checkDisk("before");
  build();
  const planFile = join(dir, "plan.json");
  prepare(["create", planFile], settings());
  const plan = JSON.parse(readFileSync(planFile, "utf8"));
  let api;
  let report;
  try {
    api = await startApi(plan, {
      port: num("port"),
      redisUrl: opt["redis-url"],
      poolSize: opt["pool-size"],
    });
    report = {
      startedAt: new Date().toISOString(),
      options: { ...opt, "admin-url": undefined, "redis-url": undefined },
      sizes: plan.sizes,
      ...(await profile(plan)),
    };
  } finally {
    api?.kill();
    prepare(["drop", plan.database, plan.redisPrefix], settings());
    writeFileSync(planFile, "");
  }
  writeFileSync(join(dir, "report.json"), JSON.stringify(report, null, 2));
  say(JSON.stringify(report, null, 2));
  say(`report: ${join(dir, "report.json")}`);
}

main().catch((error) => {
  process.stderr.write(`profile: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
