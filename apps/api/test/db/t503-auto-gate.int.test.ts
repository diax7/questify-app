import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client, type QueryResult } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  TEST_DATABASE_URL,
  createTestDatabase,
  seedTwoTenants,
  type TestDatabase,
} from "#test/support/test-db";
import { blocked, fixture, source, stats, type Fixture } from "#test/support/t503-terminal-fixture";

const evidence: Record<string, unknown> = {
  candidate: "one automatic transaction-level deferred finalizer",
  membersPerEvent: 50_000,
  productionChanges: false,
  sustainedLoad: "UNPROVEN",
  fullWriterInventory: "UNPROVEN",
  productionLifecycle: "UNPROVEN",
  canonicalOwnRank: "UNPROVEN",
  hardMeanUnder3Ms: "UNPROVEN",
  targetMeanAtMost1_5Ms: "UNPROVEN",
  automaticRuns: [],
};
let drainFailed = false;
let db: TestDatabase;
let second: Client;
let hot: Fixture;
let crossing: Fixture;
let firstPid: number;
let secondPid: number;

function literalUuid(value: string) {
  if (!/^[0-9a-f-]{36}$/.test(value)) throw new Error("not a synthetic UUID");
  return "'" + value + "'::uuid";
}

async function timedSource(target: Fixture, index: number, candidate: boolean) {
  const participant = target.participants[index];
  if (participant === undefined) throw new Error("missing participant");
  const start = performance.now();
  await db.app.query("BEGIN");
  await db.app.query("SELECT set_config('app.player_id',$1,true)", [participant.player_id]);
  const clock = candidate
    ? ", (extract(epoch FROM clock_timestamp())-current_setting('t503_auto.before_acquire')::numeric)*1000 upper_ms, " +
      "(current_setting('t503_auto.finished')::numeric-current_setting('t503_auto.acquired')::numeric)*1000 lower_ms"
    : "";
  const results = (await db.app.query(
    "SELECT * FROM complete_quest(" +
      literalUuid(target.quest) +
      ", 'code', NULL, 'GATE', " +
      literalUuid(randomUUID()) +
      "::text, NULL); COMMIT; " +
      "SELECT NOT EXISTS(SELECT FROM pg_locks WHERE pid=pg_backend_pid() AND granted " +
      "AND locktype='advisory' AND classid=508) released" +
      clock,
  )) as unknown as QueryResult[];
  expect(results[0]?.rows[0]).toMatchObject({ replayed: false, points: "25" });
  expect(results[1]?.command).toBe("COMMIT");
  expect(results[2]?.rows[0]?.released).toBe(true);
  return {
    client: performance.now() - start,
    lower: Number(results[2]?.rows[0]?.lower_ms ?? 0),
    upper: Number(results[2]?.rows[0]?.upper_ms ?? 0),
  };
}

async function workloads(candidate: boolean) {
  const runs = [];
  for (let repetition = 0; repetition < 2; repetition += 1) {
    for (const crosses of [false, true]) {
      const target = crosses ? crossing : hot;
      const before = await counts(target);
      const samples = [];
      for (let sample = 0; sample < 36; sample += 1) {
        samples.push(
          await timedSource(
            target,
            crosses ? (sample % 2 === 0 ? 10 : 9) : 2000 + sample,
            candidate,
          ),
        );
      }
      const after = await counts(target);
      const warm = samples.slice(6);
      const delta = Object.fromEntries(
        Object.keys(before).map((key) => [key, Number(after[key]) - Number(before[key])]),
      );
      expect(delta["completions"]).toBe(36);
      expect(delta["ledger"]).toBe(36);
      if (candidate) {
        expect(delta["revision"]).toBe(36);
        expect(delta["facts"]).toBe(crosses ? 72 : 0);
      }
      runs.push({
        repetition: repetition + 1,
        crosses,
        delta,
        clientMs: stats(warm.map((sample) => sample.client)),
        lowerMs: stats(warm.map((sample) => sample.lower)),
        upperMs: stats(warm.map((sample) => sample.upper)),
      });
    }
  }
  evidence[candidate ? "automaticRuns" : "originalBaselineRuns"] = runs;
}

async function counts(target: Fixture): Promise<Record<string, number>> {
  const business = (
    await db.owner.query(
      "SELECT (SELECT count(*)::integer FROM quest_completion WHERE event_id=$1) completions, " +
        "(SELECT count(*)::integer FROM ledger_entry WHERE event_id=$1 AND kind='quest') ledger",
      [target.event],
    )
  ).rows[0];
  const installed = (await db.owner.query("SELECT to_regclass('t503_auto.state') present")).rows[0]
    ?.present;
  if (!installed) return { ...business, revision: 0, facts: 0 };
  return {
    ...business,
    ...(
      await db.owner.query(
        "SELECT revision::integer, (SELECT count(*)::integer FROM t503_auto.fact WHERE event_id=$1) facts " +
          "FROM t503_auto.state WHERE event_id=$1",
        [target.event],
      )
    ).rows[0],
  };
}

async function setup() {
  db = await createTestDatabase();
  const ids = await seedTwoTenants(db.owner);
  hot = await fixture(db.owner, ids.orgA, 50_000, "autohot");
  crossing = await fixture(db.owner, ids.orgB, 50_000, "autocross");
  for (const target of [hot, crossing]) {
    await db.owner.query("UPDATE enrollment SET score=score+10000000 WHERE id=ANY($1::uuid[])", [
      target.participants.slice(0, 9).map((participant) => participant.id),
    ]);
  }
  second = new Client({ connectionString: db.appUrl });
  await second.connect();
  await db.app.query("SET statement_timeout='5s'");
  await second.query("SET statement_timeout='5s'");
  await db.owner.query("SET statement_timeout='8s'; ANALYZE");
  firstPid = Number((await db.app.query("SELECT pg_backend_pid() pid")).rows[0]?.pid);
  secondPid = Number((await second.query("SELECT pg_backend_pid() pid")).rows[0]?.pid);
  evidence["setup"] = (
    await db.owner.query(
      "SELECT version(),current_setting('fsync') fsync,current_setting('synchronous_commit') synchronous_commit," +
        "current_setting('full_page_writes') full_page_writes",
    )
  ).rows[0];
  await workloads(false);
  await db.owner.query(
    await readFile(new URL("../support/t503-auto-probe.sql", import.meta.url), "utf8"),
  );
  await db.owner.query("SET statement_timeout='60s'");
  for (const target of [hot, crossing]) {
    await db.owner.query(
      "INSERT INTO t503_auto.entry SELECT $1,id,score,score_version FROM ranked_enrollments($1) WHERE ranked",
      [target.event],
    );
    await db.owner.query(
      "INSERT INTO t503_auto.state(event_id,top_ids) VALUES($1,ARRAY(SELECT enrollment_id " +
        "FROM t503_auto.entry WHERE event_id=$1 ORDER BY score DESC,score_version,enrollment_id LIMIT 10))",
      [target.event],
    );
  }
  await db.owner.query("ANALYZE t503_auto.entry");
  await db.owner.query("SET statement_timeout='8s'");
}

async function commitSource(client: Client, target: Fixture, index: number) {
  await client.query("BEGIN");
  await source(client, target, index);
  await client.query("COMMIT");
}

async function snapshot() {
  const result: Record<string, unknown> = {};
  for (const table of [
    "quest_completion",
    "ledger_entry",
    "t503_auto.state",
    "t503_auto.fact",
    "t503_auto.latest",
    "t503_auto.pending",
    "t503_auto.dirty",
    "t503_auto.trace",
  ]) {
    result[table] = (
      await db.owner.query(
        "SELECT to_jsonb(item) value FROM " + table + " item ORDER BY to_jsonb(item)::text",
      )
    ).rows;
  }
  for (const table of ["enrollment", "t503_auto.entry"]) {
    const column = table === "enrollment" ? "id" : "enrollment_id";
    result[table] = (
      await db.owner.query(
        "SELECT to_jsonb(item) value FROM " + table + " item WHERE " + column + "=$1",
        [hot.participants[10]?.id],
      )
    ).rows;
  }
  return result;
}

async function concurrencyProofs() {
  const before = await counts(crossing);
  await db.app.query("BEGIN");
  await source(db.app, crossing, 9);
  await second.query("BEGIN");
  await source(second, crossing, 10);
  await second.query("SET CONSTRAINTS ALL IMMEDIATE");
  const waiting = db.app.query("COMMIT");
  await blocked(db.owner, firstPid, secondPid);
  await second.query("COMMIT");
  await waiting;
  const after = await counts(crossing);
  expect(after["revision"]).toBe(Number(before["revision"]) + 2);
  expect(after["facts"]).toBe(Number(before["facts"]) + 4);
  const facts = (
    await db.owner.query(
      "SELECT revision::integer,direction FROM t503_auto.fact " +
        "WHERE event_id=$1 AND enrollment_id=$2 ORDER BY revision",
      [crossing.event, crossing.participants[10]?.id],
    )
  ).rows;
  expect(facts).toEqual([
    { revision: 1, direction: "entry" },
    { revision: 2, direction: "exit" },
  ]);
  await db.app.query("BEGIN");
  await source(db.app, hot, 4000);
  await second.query("BEGIN");
  const same = source(second, hot, 4000);
  await blocked(db.owner, secondPid, firstPid);
  await db.app.query("COMMIT");
  await same;
  await second.query("COMMIT");
  evidence["writers"] =
    "PASS: A starts first/B commits first across different enrollments; same-enrollment waiter owns no E";
}

async function readerProof() {
  await second.query("BEGIN");
  await source(second, crossing, 10);
  await second.query("SET CONSTRAINTS ALL IMMEDIATE");
  await db.app.query("BEGIN");
  const read = db.app.query("SELECT t503_auto_read($1) ids", [crossing.event]);
  await blocked(db.owner, firstPid, secondPid);
  await second.query("COMMIT");
  expect((await read).rows[0]?.ids).toContain(crossing.participants[10]?.id);
  await db.app.query("COMMIT");
  evidence["readCommittedFreshAfterE"] = "PASS: blocking reader sees newly committed entrant";
}

async function refusedBackedges() {
  await second.query("BEGIN");
  await source(second, hot, 4001);
  const statements = [
    {
      sql: "SELECT * FROM record_completion($1,$2,'code',NULL,'GATE',$3,NULL,NULL,NULL,NULL,$4,NULL)",
      values: [hot.quest, hot.participants[4001]?.player_id, randomUUID(), hot.event],
    },
    { sql: "UPDATE enrollment SET score=score WHERE id=$1", values: [hot.participants[4001]?.id] },
    {
      sql: "INSERT INTO t503_auto.deferred_job VALUES($1,1)",
      values: [hot.participants[4001]?.id],
    },
  ];
  for (const statement of statements) {
    await db.owner.query("BEGIN; SET LOCAL lock_timeout='100ms'");
    await source(db.owner, hot, 4002);
    await db.owner.query("SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED");
    await expect(db.owner.query(statement.sql, statement.values)).rejects.toMatchObject({
      code: "42501",
    });
    await db.owner.query("ROLLBACK");
  }
  await second.query("ROLLBACK");
  await db.owner.query("BEGIN; SET CONSTRAINTS ALL IMMEDIATE");
  await expect(source(db.owner, hot, 4003)).rejects.toMatchObject({ code: "42501" });
  await db.owner.query("ROLLBACK");
  evidence["beforeLockRefusals"] =
    "PASS: nested record_completion, statement DML, re-armed deferred insert; premature immediate source rejected before E";
}

async function multiEventProof() {
  const before = (
    await db.owner.query("SELECT coalesce(max(ordinal),0)::integer value FROM t503_auto.trace")
  ).rows[0]?.value;
  await db.owner.query("BEGIN");
  await source(db.owner, hot, 4004);
  await db.owner.query("INSERT INTO t503_auto.deferred_job VALUES($1,1)", [
    crossing.participants[4004]?.id,
  ]);
  expect(
    (await db.owner.query("SELECT count(*)::integer count FROM t503_auto.pending")).rows[0]?.count,
  ).toBe(1);
  await db.owner.query("COMMIT");
  const order = (
    await db.owner.query("SELECT event_id FROM t503_auto.trace WHERE ordinal>$1 ORDER BY ordinal", [
      before,
    ])
  ).rows;
  const expected = (
    await db.owner.query(
      "SELECT event_id FROM t503_auto.state ORDER BY hashtext(event_id::text),event_id",
    )
  ).rows;
  expect(order).toEqual(expected);
  await db.app.query("BEGIN");
  await source(db.app, hot, 4005);
  await source(db.app, crossing, 4005);
  await second.query("BEGIN");
  await source(second, crossing, 4006);
  await source(second, hot, 4006);
  await db.app.query("SET CONSTRAINTS ALL IMMEDIATE");
  const commit = second.query("COMMIT");
  await blocked(db.owner, secondPid, firstPid);
  await db.app.query("COMMIT");
  await commit;
  evidence["multipleEvents"] =
    "PASS: one pending callback; drain adds second event; hash/UUID-sorted E even with opposite business order";
}

async function globalProof() {
  await db.app.query("BEGIN");
  await source(db.app, hot, 4007);
  await second.query("BEGIN");
  const reset = second.query("SELECT t503_auto_reset($1)", [hot.event]);
  await blocked(db.owner, secondPid, firstPid);
  await db.app.query("COMMIT");
  await reset;
  await second.query("COMMIT");
  await second.query("BEGIN; SELECT t503_auto_reset('" + hot.event + "'::uuid)");
  await db.app.query("BEGIN");
  const writer = source(db.app, hot, 4008);
  await blocked(db.owner, firstPid, secondPid);
  await second.query("COMMIT");
  await writer;
  await expect(db.app.query("SELECT t503_auto_reset($1)", [hot.event])).rejects.toMatchObject({
    code: "42501",
  });
  await db.app.query("ROLLBACK");
  evidence["syntheticGlobalReset"] =
    "PASS: both G orders, forbidden shared upgrade; production lifecycle UNPROVEN";
}

describe
  .skipIf(TEST_DATABASE_URL === undefined || process.env["T503_AUTO_GATE"] !== "1")
  .sequential("T503 automatic commit candidate, isolated and not production acceptance", () => {
    beforeAll(setup, 300_000);
    beforeEach((context) => {
      if (drainFailed) context.skip();
    });
    afterEach(async () => {
      await Promise.all([
        db.app.query("ROLLBACK"),
        second.query("ROLLBACK"),
        db.owner.query("ROLLBACK"),
      ]);
    });
    afterAll(async () => {
      process.stdout.write("T503_AUTO_EVIDENCE " + JSON.stringify(evidence) + "\n");
      await second?.end();
      await db?.close();
    });
    it("makes the original omitted-publisher red impossible without any optional helper", async () => {
      const before = await counts(hot);
      await commitSource(db.app, hot, 3000);
      const after = await counts(hot);
      expect(after["revision"]).toBe(Number(before["revision"]) + 1);
      expect(after["completions"]).toBe(Number(before["completions"]) + 1);
      expect(after["ledger"]).toBe(Number(before["ledger"]) + 1);
      expect(
        (await db.owner.query("SELECT count(*)::integer count FROM t503_auto.pending")).rows[0]
          ?.count,
      ).toBe(0);
      evidence["omittedPublisher"] = { status: "PASS", before, after };
    });
    it("keeps incremental eligibility correct for a representative enrollment change", async () => {
      const member = hot.participants[4500]?.id;
      await db.owner.query("UPDATE enrollment SET status='banned' WHERE id=$1", [member]);
      expect(
        (
          await db.owner.query(
            "SELECT count(*)::integer count FROM t503_auto.entry WHERE enrollment_id=$1",
            [member],
          )
        ).rows[0]?.count,
      ).toBe(0);
      await db.owner.query("UPDATE enrollment SET status='active' WHERE id=$1", [member]);
      expect(
        (
          await db.owner.query(
            "SELECT count(*)::integer count FROM t503_auto.entry WHERE enrollment_id=$1",
            [member],
          )
        ).rows[0]?.count,
      ).toBe(1);
      evidence["incrementalEligibility"] =
        "PASS: changed-row remove/reinsert; other eligibility writer inventory UNPROVEN";
    });
    it("drains already queued and recursively re-armed deferred business before E", async () => {
      await db.owner.query("BEGIN");
      await source(db.owner, hot, 3001);
      await db.owner.query("INSERT INTO t503_auto.deferred_job VALUES($1,2)", [
        hot.participants[3002]?.id,
      ]);
      try {
        await db.owner.query("COMMIT");
      } catch (error) {
        drainFailed = true;
        const failure = error as { code?: string; message?: string; where?: string };
        evidence["deferredDrain"] = {
          status: "FAIL",
          code: failure.code,
          message: failure.message,
          where: failure.where,
          remainingProofs: "UNPROVEN; stop, no candidate timings",
        };
        throw error;
      }
      const traces = (await db.owner.query("SELECT phase FROM t503_auto.deferred_trace")).rows;
      expect(traces).toEqual([{ phase: "draining" }, { phase: "draining" }, { phase: "draining" }]);
      evidence["deferredDrain"] = {
        status: "PASS",
        callbacks: 1,
        businessCallbacks: traces.length,
      };
    });
    it("rolls back real COMMIT failure across source, ledger, projection, snapshot and facts", async () => {
      const before = await snapshot();
      await db.app.query("BEGIN; SET LOCAL t503_auto.fail='on'");
      await source(db.app, hot, 10);
      await expect(db.app.query("COMMIT")).rejects.toMatchObject({ code: "P0001" });
      expect(await snapshot()).toEqual(before);
      evidence["commitFailureRollback"] = "PASS: exact all-table snapshots unchanged";
    });
    it("retains ordered entry1 exit2 entry3 and exact latest identity with new generation", async () => {
      await db.app.query("SELECT t503_auto_reset($1)", [hot.event]);
      const member = hot.participants[10]?.id;
      await commitSource(db.app, hot, 10);
      await commitSource(db.app, hot, 9);
      await commitSource(db.app, hot, 10);
      const facts = (
        await db.owner.query(
          "SELECT generation::integer,revision::integer,direction FROM t503_auto.fact " +
            "WHERE event_id=$1 AND enrollment_id=$2 ORDER BY generation,revision",
          [hot.event, member],
        )
      ).rows;
      expect(facts).toEqual([
        { generation: 2, revision: 1, direction: "entry" },
        { generation: 2, revision: 2, direction: "exit" },
        { generation: 2, revision: 3, direction: "entry" },
      ]);
      expect(
        (
          await db.owner.query(
            "SELECT generation::integer,revision::integer FROM t503_auto.latest " +
              "WHERE event_id=$1 AND enrollment_id=$2",
            [hot.event, member],
          )
        ).rows,
      ).toEqual([{ generation: 2, revision: 3 }]);
      evidence["exactLatest"] = { status: "PASS", facts };
    });
    it("proves competing commit order with a fresh snapshot after waiting E", concurrencyProofs);
    it("reads a fresh READ COMMITTED snapshot after waiting E", readerProof);
    it("refuses nested payers and DML before further legacy row locks", refusedBackedges);
    it("drains multiple dirty events once and takes every E in stable order", multiEventProof);
    it("proves both global reset orders and rejects shared upgrades", globalProof);
    it("measures two bounded real-source crossing and noncrossing repetitions at 50k", async () => {
      await db.owner.query(
        "UPDATE enrollment SET score=CASE WHEN id=$1 THEN 500000 ELSE 499990 END WHERE id=ANY($2::uuid[])",
        [
          crossing.participants[9]?.id,
          [crossing.participants[9]?.id, crossing.participants[10]?.id],
        ],
      );
      await workloads(true);
      const runs = evidence["automaticRuns"] as {
        upperMs: { mean: number };
        lowerMs: { mean: number };
      }[];
      evidence["hardMeanUnder3Ms"] = runs.every((run) => run.upperMs.mean < 3)
        ? "PASS"
        : "UNPROVEN";
      evidence["targetMeanAtMost1_5Ms"] = runs.every((run) => run.upperMs.mean <= 1.5)
        ? "PASS"
        : "UNPROVEN";
    }, 30_000);
  });
