import { readFile } from "node:fs/promises";
import { availableParallelism, cpus, platform, release, totalmem } from "node:os";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  TEST_DATABASE_URL,
  createTestDatabase,
  seedTwoTenants,
  type TestDatabase,
} from "#test/support/test-db";
import { blocked, fixture, source, stats, type Fixture } from "#test/support/t503-terminal-fixture";

const evidence: Record<string, unknown> = {
  members: 50_000,
  sustainedLoad: "UNPROVEN",
  productionChanges: false,
};
let db: TestDatabase;
let second: Client;
let hot: Fixture;
let crossing: Fixture;
let observerPid: number;
let secondPid: number;

async function publish(client: Client, event: string) {
  const result = await client.query<{ wait_ms: number; acquired_ms: string; published_ms: string }>(
    `SELECT wait_ms, (extract(epoch FROM acquired_at)*1000)::text acquired_ms,
      (extract(epoch FROM published_at)*1000)::text published_ms FROM t503_terminal_publish($1)`,
    [event],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("missing publication timing");
  return row;
}

async function complete(client: Client, target: Fixture, indexes: number[]) {
  await client.query("BEGIN");
  try {
    for (const index of indexes) await source(client, target, index);
    const timing = await publish(client, target.event);
    const commit =
      (await client.query(`SELECT (extract(epoch FROM clock_timestamp())*1000)::text timestamp_ms;
      COMMIT;
      SELECT (extract(epoch FROM clock_timestamp())*1000)::text timestamp_ms,
      NOT EXISTS(SELECT FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory'
        AND classid=506 AND granted) released`)) as unknown as {
        rows: { timestamp_ms: string; released: boolean }[];
      }[];
    expect(commit[2]?.rows[0]?.released).toBe(true);
    return {
      wait: timing.wait_ms,
      lower: Number(timing.published_ms) - Number(timing.acquired_ms),
      precommitLower: Number(commit[0]?.rows[0]?.timestamp_ms) - Number(timing.acquired_ms),
      commitTail:
        Number(commit[2]?.rows[0]?.timestamp_ms) - Number(commit[0]?.rows[0]?.timestamp_ms),
      upper: Number(commit[2]?.rows[0]?.timestamp_ms) - Number(timing.acquired_ms),
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function profile(label: string, candidate: boolean) {
  await db.owner.query(
    "SELECT pg_stat_force_next_flush(); SELECT pg_stat_reset(); SELECT pg_stat_clear_snapshot()",
  );
  const sourceMs: number[] = [];
  const commitMs: number[] = [];
  const transactionMs: number[] = [];
  for (let index = 0; index < 60; index += 1) {
    const transaction = performance.now();
    await db.owner.query("BEGIN; SET LOCAL ROLE questify_app");
    const start = performance.now();
    await source(db.owner, hot, 1000 + index);
    sourceMs.push(performance.now() - start);
    if (candidate) await publish(db.owner, hot.event);
    const commit = performance.now();
    await db.owner.query("COMMIT");
    commitMs.push(performance.now() - commit);
    transactionMs.push(performance.now() - transaction);
  }
  await db.owner.query("SELECT pg_stat_force_next_flush(); SELECT pg_stat_clear_snapshot()");
  const functions = (
    await db.owner.query(
      `SELECT schemaname, funcname, calls, round(total_time::numeric, 3)::float8 total_ms,
      round(self_time::numeric, 3)::float8 self_ms FROM pg_stat_user_functions
      WHERE calls > 0 ORDER BY self_time DESC`,
    )
  ).rows;
  evidence[label] = {
    coldSourceClientMs: sourceMs[0],
    warmSourceClientMs: stats(sourceMs.slice(10)),
    sourceClientMs: stats(sourceMs),
    commitClientMs: stats(commitMs),
    transactionClientMs: stats(transactionMs),
    warmTransactionClientMs: stats(transactionMs.slice(10)),
    functions,
  };
}

async function setup() {
  db = await createTestDatabase();
  const ids = await seedTwoTenants(db.owner);
  hot = await fixture(db.owner, ids.orgA, 50_000, "hot");
  crossing = await fixture(db.owner, ids.orgB, 11, "cross");
  second = new Client({ connectionString: db.appUrl });
  await second.connect();
  await db.app.query("SET statement_timeout = '8s'");
  await second.query("SET statement_timeout = '8s'");
  observerPid = Number((await db.app.query("SELECT pg_backend_pid() pid")).rows[0].pid);
  secondPid = Number((await second.query("SELECT pg_backend_pid() pid")).rows[0].pid);
  await db.owner.query("ANALYZE; SET track_functions = 'all'");
  evidence["setup"] = (
    await db.owner.query(
      `SELECT version(), current_setting('synchronous_commit') synchronous_commit,
        current_setting('fsync') fsync, current_setting('full_page_writes') full_page_writes,
        current_setting('shared_buffers') shared_buffers, current_setting('work_mem') work_mem`,
    )
  ).rows;
  evidence["machine"] = {
    platform: platform(),
    release: release(),
    cpu: cpus()[0]?.model,
    parallelism: availableParallelism(),
    memoryGiB: totalmem() / 1024 ** 3,
    node: process.version,
  };
  await profile("baseline", false);
  await originalProfile();
  await db.owner.query(
    await readFile(new URL("../support/t503-terminal-probe.sql", import.meta.url), "utf8"),
  );
  for (const target of [hot, crossing]) {
    await db.owner.query(
      `INSERT INTO t503_terminal.entry SELECT $1, id, score, score_version
      FROM ranked_enrollments($1) WHERE ranked`,
      [target.event],
    );
    await db.owner.query(
      `INSERT INTO t503_terminal.state (event_id, top_ids) VALUES ($1,
      ARRAY(SELECT enrollment_id FROM t503_terminal.entry WHERE event_id = $1
        ORDER BY score DESC, score_version, enrollment_id LIMIT 10))`,
      [target.event],
    );
  }
  await db.owner.query("ANALYZE t503_terminal.entry");
  await profile("candidateProfile", true);
}

async function originalProfile() {
  await db.owner.query(
    await readFile(new URL("../support/t503-rank-probe.sql", import.meta.url), "utf8"),
  );
  await db.owner.query(
    `INSERT INTO t503_probe.entry SELECT $1, id, score, score_version
    FROM ranked_enrollments($1) WHERE ranked`,
    [hot.event],
  );
  await db.owner.query(
    `INSERT INTO t503_probe.state (event_id, top_ids) VALUES ($1,
    ARRAY(SELECT enrollment_id FROM t503_probe.entry WHERE event_id=$1
      ORDER BY score DESC,score_version,enrollment_id LIMIT 10))`,
    [hot.event],
  );
  await db.owner.query("ANALYZE t503_probe.entry");
  await profile("originalEarlyProbe", false);
  evidence["originalHoldLowerMs"] = stats(
    (
      await db.owner.query<{ hold_lower_ms: number }>(
        "SELECT hold_lower_ms FROM t503_probe.measurement",
      )
    ).rows.map((row) => row.hold_lower_ms),
  );
  await db.owner.query(`DROP TRIGGER t503_changed ON enrollment;
    DROP FUNCTION public.complete_quest(uuid,text,integer,text,text,uuid,jsonb);
    ALTER FUNCTION t503_probe.complete_quest(uuid,text,integer,text,text,uuid,jsonb) SET SCHEMA public;
    DROP SCHEMA t503_probe CASCADE`);
}

async function metadataAndReads() {
  evidence["deferredInventory"] = (
    await db.owner.query(`SELECT conrelid::regclass::text relation, conname, contype,
    condeferrable, condeferred, confrelid::regclass::text referenced, confdeltype
    FROM pg_constraint WHERE connamespace='public'::regnamespace AND
      (condeferrable OR (contype='f' AND conrelid IN ('enrollment'::regclass,'ledger_entry'::regclass,
        'quest_completion'::regclass,'xp_entry'::regclass,'player_xp'::regclass)))
    ORDER BY relation,conname`)
  ).rows;
  evidence["businessTriggers"] = (
    await db.owner
      .query(`SELECT tgrelid::regclass::text relation, tgname, tgfoid::regproc::text function,
    tgdeferrable, tginitdeferred FROM pg_trigger WHERE NOT tgisinternal AND tgrelid IN (
      'enrollment'::regclass,'ledger_entry'::regclass,'quest_completion'::regclass,'xp_entry'::regclass,
      'player_xp'::regclass) ORDER BY relation,tgname`)
  ).rows;
  const reads: Record<string, unknown> = {};
  for (const [label, query] of Object.entries({
    canonicalTop:
      "SELECT id FROM ranked_enrollments($1) WHERE ranked ORDER BY score DESC,score_version,id LIMIT 10",
    projectionTop:
      "SELECT enrollment_id FROM t503_terminal.entry WHERE event_id=$1 ORDER BY score DESC,score_version,enrollment_id LIMIT 10",
    projectionTotal: "SELECT count(*) FROM t503_terminal.entry WHERE event_id=$1",
    projectionOwn: `SELECT count(*)+1 FROM t503_terminal.entry WHERE event_id=$1 AND
      (score > 499900 OR (score=499900 AND score_version < 11))`,
  })) {
    const samples = [];
    for (let index = 0; index < 8; index += 1) {
      const started = performance.now();
      await db.owner.query(query, [hot.event]);
      samples.push(performance.now() - started);
    }
    reads[label] = { firstClientMs: samples[0], warmClientMs: stats(samples.slice(1)) };
  }
  evidence["reads"] = {
    eligible: reads,
    coldCache: "UNPROVEN: no cache eviction",
    excluded49990: "UNPROVEN",
  };
}

async function capture(client: Client, event: string) {
  return (
    await client.query(
      `SELECT
    (SELECT jsonb_agg(to_jsonb(enrollment) ORDER BY id) FROM enrollment WHERE event_id=$1) enrollment,
    (SELECT count(*) FROM quest_completion WHERE event_id=$1) completions,
    (SELECT count(*) FROM ledger_entry WHERE event_id=$1) ledger,
    (SELECT jsonb_agg(to_jsonb(entry) ORDER BY enrollment_id) FROM t503_terminal.entry entry WHERE event_id=$1) projection,
    (SELECT to_jsonb(state) FROM t503_terminal.state state WHERE event_id=$1) state,
    (SELECT jsonb_agg(to_jsonb(fact) ORDER BY revision, enrollment_id) FROM t503_terminal.fact fact WHERE event_id=$1) facts,
    (SELECT jsonb_agg(to_jsonb(latest) ORDER BY enrollment_id) FROM t503_terminal.latest latest WHERE event_id=$1) latest`,
      [event],
    )
  ).rows;
}

function correctnessTests() {
  it("retains each committed 11 -> 9 -> 11 and entry1 -> exit2 -> entry3 exact identity", async () => {
    await complete(db.app, crossing, [10]);
    await complete(db.app, crossing, [8, 9]);
    await complete(db.app, crossing, [10]);
    const member = crossing.participants[10]?.id;
    const facts = (
      await db.owner.query(
        `SELECT generation::integer, revision::integer, direction
      FROM t503_terminal.fact WHERE event_id=$1 AND enrollment_id=$2 ORDER BY revision`,
        [crossing.event, member],
      )
    ).rows;
    expect(facts).toEqual([
      { generation: 1, revision: 1, direction: "entry" },
      { generation: 1, revision: 2, direction: "exit" },
      { generation: 1, revision: 3, direction: "entry" },
    ]);
    expect(
      (
        await db.owner.query(
          `SELECT revision::integer FROM t503_terminal.fact fact
      JOIN t503_terminal.latest USING(event_id,enrollment_id,generation,revision)
      WHERE event_id=$1 AND enrollment_id=$2`,
          [crossing.event, member],
        )
      ).rows,
    ).toEqual([{ revision: 3 }]);
    evidence["crossings"] = facts;
  });
  it("rolls source, enrollment, projection, snapshot and exact facts back together", async () => {
    const before = await capture(db.owner, crossing.event);
    await db.app.query("BEGIN");
    await source(db.app, crossing, 10);
    await publish(db.app, crossing.event);
    await db.app.query("ROLLBACK");
    expect(await capture(db.owner, crossing.event)).toEqual(before);
  });
  it("denies private/raw writes, internal calls, outsider publish and post-fence completion", async () => {
    for (const client of [db.app, db.outsider]) {
      await expect(client.query("SELECT * FROM t503_terminal.entry")).rejects.toMatchObject({
        code: "42501",
      });
      await expect(
        client.query("SELECT t503_terminal.enter_source($1)", [hot.event]),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        client.query("UPDATE public.enrollment SET score=score+1 WHERE id=$1", [
          hot.participants[0]?.id,
        ]),
      ).rejects.toMatchObject({ code: "42501" });
    }
    await expect(
      db.outsider.query("SELECT public.t503_terminal_publish($1)", [hot.event]),
    ).rejects.toMatchObject({ code: "42501" });
    await db.app.query("BEGIN");
    await source(db.app, hot, 500);
    await publish(db.app, hot.event);
    await expect(source(db.app, hot, 501)).rejects.toMatchObject({ code: "42501" });
    await db.app.query("ROLLBACK");
  });
}

function concurrencyTests() {
  it("A starts first, B commits first; waiting E snapshot includes B and A", async () => {
    await db.app.query("BEGIN");
    await source(db.app, hot, 10);
    await second.query("BEGIN");
    await source(second, hot, 8);
    await source(second, hot, 9);
    await publish(second, hot.event);
    const waiting = publish(db.app, hot.event);
    await blocked(db.owner, observerPid, secondPid);
    await second.query("COMMIT");
    const timing = await waiting;
    await db.app.query("COMMIT");
    const canonical = (
      await db.owner.query(
        `SELECT ARRAY(SELECT enrollment_id FROM t503_terminal.entry
      WHERE event_id=$1 ORDER BY score DESC,score_version,enrollment_id LIMIT 10) ids`,
        [hot.event],
      )
    ).rows[0]?.ids;
    expect(
      (
        await db.owner.query("SELECT top_ids FROM t503_terminal.state WHERE event_id=$1", [
          hot.event,
        ])
      ).rows[0]?.top_ids,
    ).toEqual(canonical);
    evidence["distinctBlocking"] = {
      edge: "A -> B exclusive E through COMMIT",
      waitMs: timing.wait_ms,
    };
  });
  it("conflicting enrollment blocks in business before E, without a cycle", async () => {
    await db.app.query("BEGIN");
    await second.query("BEGIN");
    await source(second, hot, 602);
    const waiting = source(db.app, hot, 602);
    await blocked(db.owner, observerPid, secondPid);
    await publish(second, hot.event);
    await second.query("COMMIT");
    await waiting;
    await publish(db.app, hot.event);
    await db.app.query("COMMIT");
    evidence["conflictingBlocking"] =
      "A started first; B business/fence/commit first; A resumes then fences";
  });
}

function timingTests() {
  it("measures repeated full-source 50k fence residence with COMMIT release upper bounds", async () => {
    const runs = [];
    for (let run = 0; run < 5; run += 1) {
      const factsBefore = Number(
        (
          await db.owner.query("SELECT count(*) FROM t503_terminal.fact WHERE event_id=$1", [
            hot.event,
          ])
        ).rows[0]?.count,
      );
      const client: number[] = [],
        lower: number[] = [],
        upper: number[] = [],
        wait: number[] = [];
      const precommit: number[] = [],
        commitTail: number[] = [];
      for (let index = 0; index < (run < 3 ? 70 : 40); index += 1) {
        const started = performance.now();
        const indexes = run < 3 ? [2000 + run * 70 + index] : index % 2 === 0 ? [10] : [8, 9];
        const timing = await complete(db.app, hot, indexes);
        if (index < 10) continue;
        client.push(performance.now() - started);
        lower.push(timing.lower);
        upper.push(timing.upper);
        wait.push(timing.wait);
        precommit.push(timing.precommitLower);
        commitTail.push(timing.commitTail);
      }
      runs.push({
        work: run < 3 ? "noncrossing" : "alternating-top-members",
        crossingFactsIncludingWarmup:
          Number(
            (
              await db.owner.query("SELECT count(*) FROM t503_terminal.fact WHERE event_id=$1", [
                hot.event,
              ])
            ).rows[0]?.count,
          ) - factsBefore,
        clientMs: stats(client),
        holdLowerMs: stats(lower),
        holdUpperMs: stats(upper),
        waitMs: stats(wait),
        precommitLowerMs: stats(precommit),
        commitTailMs: stats(commitTail),
        microgate:
          stats(upper).mean < 3 ? "PASS" : stats(precommit).mean >= 3 ? "FAIL" : "UNPROVEN",
        target:
          stats(upper).mean <= 1.5 ? "PASS" : stats(precommit).mean > 1.5 ? "FAIL" : "UNPROVEN",
      });
    }
    evidence["timings"] = runs;
    expect(runs).toHaveLength(5);
  }, 120_000);
}

function boundaryTests() {
  it("observes reader/drain and terminal E blocking in both orders", async () => {
    await second.query("BEGIN");
    await second.query("SELECT t503_terminal_read($1)", [hot.event]);
    await db.app.query("BEGIN");
    await source(db.app, hot, 700);
    const writer = publish(db.app, hot.event);
    await blocked(db.owner, observerPid, secondPid);
    await second.query("COMMIT");
    await writer;
    const reader = second.query("SELECT t503_terminal_read($1)", [hot.event]);
    await blocked(db.owner, secondPid, observerPid);
    await db.app.query("COMMIT");
    await reader;
    evidence["readerDrain"] =
      "both E orders observed; synthetic snapshot reader only, no delivery locks";
  });
  it("observes exclusive global reset both orders and refuses shared gate upgrade", async () => {
    await db.app.query("BEGIN");
    await source(db.app, crossing, 0);
    const reset = second.query("SELECT t503_terminal_reset($1)", [crossing.event]);
    await blocked(db.owner, secondPid, observerPid);
    await publish(db.app, crossing.event);
    await db.app.query("COMMIT");
    await reset;
    await second.query("BEGIN");
    await second.query("SELECT t503_terminal_reset($1)", [crossing.event]);
    await db.app.query("BEGIN");
    const writer = source(db.app, crossing, 0);
    await blocked(db.owner, observerPid, secondPid);
    await second.query("COMMIT");
    await writer;
    await expect(
      db.app.query("SELECT t503_terminal_reset($1)", [crossing.event]),
    ).rejects.toMatchObject({ code: "42501" });
    await db.app.query("ROLLBACK");
    evidence["syntheticReset"] =
      "exclusive G both orders; no shared upgrade; production lifecycle UNPROVEN";
  });
  it("exposes a real nested source back-edge after E despite late projection refusal", async () => {
    await second.query("BEGIN");
    await source(second, hot, 701);
    await db.owner.query("BEGIN");
    await source(db.owner, hot, 702);
    await publish(db.owner, hot.event);
    const ownerPid = Number((await db.owner.query("SELECT pg_backend_pid() pid")).rows[0].pid);
    await db.owner.query("SELECT set_config('app.player_id',$1,true)", [
      hot.participants[701]?.player_id,
    ]);
    const legacy = db.owner.query(
      `SELECT * FROM record_completion($1,$2,'code',NULL,'GATE','nested-backedge',
      NULL,NULL,NULL,NULL,$3,NULL)`,
      [hot.quest, hot.participants[701]?.player_id, hot.event],
    );
    const refusal = expect(legacy).rejects.toMatchObject({ code: "42501" });
    await blocked(db.app, ownerPid, secondPid);
    await second.query("ROLLBACK");
    await refusal;
    await db.owner.query("ROLLBACK");
    evidence["backedge"] =
      "FAIL: E holder waits on legacy enrollment in nested record_completion; AFTER projection guard is too late";
  });
}

function deferredTests() {
  it("flushes queued FK/business triggers before E, but re-deferral can create post-fence work", async () => {
    await db.owner.query("BEGIN");
    await source(db.owner, hot, 703);
    await db.owner.query("INSERT INTO t503_terminal.deferred_job VALUES($1)", [
      hot.participants[703]?.id,
    ]);
    await publish(db.owner, hot.event);
    expect(
      (await db.owner.query("SELECT was_fenced FROM t503_terminal.deferred_trace")).rows,
    ).toEqual([{ was_fenced: false }]);
    await db.owner.query("ROLLBACK");
    await db.owner.query("BEGIN");
    await source(db.owner, hot, 703);
    await publish(db.owner, hot.event);
    await db.owner.query("SET CONSTRAINTS ALL DEFERRED");
    await db.owner.query("INSERT INTO t503_terminal.deferred_job VALUES($1)", [
      hot.participants[703]?.id,
    ]);
    await expect(db.owner.query("COMMIT")).rejects.toMatchObject({ code: "42501" });
    await db.owner.query("ROLLBACK");
    evidence["deferred"] =
      "queued FK/trigger flushed before E; SET CONSTRAINTS can re-arm after E, rollback only at late guard; not a no-back-edge proof";
  });
  it("keeps missing terminal publication as an explicitly RED candidate guard gate", async () => {
    const before = (
      await db.owner.query("SELECT revision::integer FROM t503_terminal.state WHERE event_id=$1", [
        hot.event,
      ])
    ).rows[0]?.revision;
    await db.app.query("BEGIN");
    await source(db.app, hot, 704);
    await db.app.query("COMMIT");
    const after = (
      await db.owner.query("SELECT revision::integer FROM t503_terminal.state WHERE event_id=$1", [
        hot.event,
      ])
    ).rows[0]?.revision;
    const committed = (
      await db.owner.query(
        "SELECT count(*)::integer count FROM quest_completion WHERE event_id=$1 AND enrollment_id=$2",
        [hot.event, hot.participants[704]?.id],
      )
    ).rows[0]?.count;
    expect(committed).toBe(1);
    evidence["missingFence"] = {
      status: "FAIL",
      committedSourceWithoutPublication: after === before,
      completions: committed,
      revisionBefore: before,
      revisionAfter: after,
    };
    expect(after, "STOP: committing a source without terminal publication must be impossible").toBe(
      before + 1,
    );
  });
}

describe
  .skipIf(TEST_DATABASE_URL === undefined || process.env["T503_TERMINAL_GATE"] !== "1")
  .sequential("T503 terminal fence investigation only; no production acceptance", () => {
    beforeAll(setup, 180_000);
    afterEach(async () => {
      await db.app.query("ROLLBACK");
      await second.query("ROLLBACK");
      await db.owner.query("ROLLBACK");
    });
    afterAll(async () => {
      process.stdout.write("T503_TERMINAL_EVIDENCE " + JSON.stringify(evidence) + "\n");
      await second?.end();
      await db?.close();
    });
    correctnessTests();
    it("records bounded metadata inventory and eligible top/own/total costs", metadataAndReads);
    concurrencyTests();
    timingTests();
    boundaryTests();
    deferredTests();
  });
