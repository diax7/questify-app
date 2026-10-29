import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { availableParallelism, cpus, platform, release, totalmem } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withRequestContext } from "#src/db/context";
import {
  TEST_DATABASE_URL,
  createTestDatabase,
  seedTwoTenants,
  type TestDatabase,
} from "#test/support/test-db";

type Participant = { id: string; player_id: string };
type Fixture = { event: string; quest: string; participants: Participant[] };

const stats = (samples: number[]) => {
  const ordered = samples.toSorted((left, right) => left - right);
  return {
    count: samples.length,
    mean: samples.reduce((sum, value) => sum + value, 0) / samples.length,
    p50: ordered[Math.floor(samples.length * 0.5)],
    p95: ordered[Math.floor(samples.length * 0.95)],
    p99: ordered[Math.floor(samples.length * 0.99)],
  };
};

describe
  .skipIf(TEST_DATABASE_URL === undefined || process.env["T503_RANK_GATE"] !== "1")
  .sequential("T503 isolated full-source early gate (not a production migration)", () => {
    let db: TestDatabase;
    let crossing: Fixture;
    let hot: Fixture;
    let baseline: number[];

    const source = async (target: Fixture, index: number) => {
      const participant = target.participants[index];
      if (participant === undefined) throw new Error("missing participant");
      await db.app.query("SELECT set_config('app.player_id', $1, true)", [participant.player_id]);
      return db.app.query("SELECT * FROM complete_quest($1, 'code', NULL, 'GATE', $2, NULL)", [
        target.quest,
        randomUUID(),
      ]);
    };
    const complete = (target: Fixture, indexes: number[]) =>
      withRequestContext(db.app, {}, async () => {
        for (const index of indexes) await source(target, index);
      });

    const fixture = async (organizer: string, count: number, prefix: string): Promise<Fixture> => {
      const { rows: events } = await db.owner.query<{ id: string }>(
        `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at, activated_at)
         VALUES ($1, $2, 'Gate', 'live', now() - interval '1 hour', now() + interval '1 day', now()) RETURNING id`,
        [organizer, prefix.toUpperCase() + "1"],
      );
      const event = events[0]?.id ?? "";
      await db.owner.query(
        `INSERT INTO player (username)
        SELECT $1 || '_' || series FROM generate_series(1, $2::integer) series`,
        [prefix, count],
      );
      await db.owner.query(
        `INSERT INTO player_contact (player_id, email)
        SELECT id, username || '@gate.test' FROM player WHERE username LIKE $1`,
        [prefix + "_%"],
      );
      await db.owner.query(
        `INSERT INTO enrollment (organizer_id, event_id, player_id, score, balance, score_version)
        SELECT $1, $2, id, ($3::bigint + 1 - split_part(username, '_', 2)::integer) * 10, 0,
          split_part(username, '_', 2)::integer FROM player WHERE username LIKE $4`,
        [organizer, event, count, prefix + "_%"],
      );
      const participants = (
        await db.owner.query<Participant>(
          "SELECT id, player_id FROM enrollment WHERE event_id = $1 ORDER BY score DESC, score_version",
          [event],
        )
      ).rows;
      expect(participants).toHaveLength(count);
      const { rows: quests } = await db.owner.query<{ id: string }>(
        `INSERT INTO quest (event_id, category_id, type, title_en, points, repeat_cap, type_config)
         SELECT $1, id, 'enter_code', 'Gate', 25, 100, jsonb_build_object('code', 'GATE')
         FROM category WHERE event_id = $1 RETURNING id`,
        [event],
      );
      return { event, quest: quests[0]?.id ?? "", participants };
    };

    beforeAll(async () => {
      db = await createTestDatabase();
      const ids = await seedTwoTenants(db.owner);
      crossing = await fixture(ids.orgA, 11, "cross");
      hot = await fixture(ids.orgB, 50_000, "hot");
      await db.owner.query("ANALYZE");
      baseline = [];
      for (let index = 0; index < 120; index += 1) {
        const started = performance.now();
        await complete(hot, [index]);
        if (index >= 20) baseline.push(performance.now() - started);
      }
      await db.owner.query(
        await readFile(new URL("../support/t503-rank-probe.sql", import.meta.url), "utf8"),
      );
      for (const event of [crossing.event, hot.event]) {
        await db.owner.query(
          `INSERT INTO t503_probe.entry SELECT $1, id, score, score_version
          FROM ranked_enrollments($1) WHERE ranked`,
          [event],
        );
        await db.owner.query(
          `INSERT INTO t503_probe.state (event_id, top_ids) VALUES ($1,
          ARRAY(SELECT enrollment_id FROM t503_probe.entry WHERE event_id = $1
            ORDER BY score DESC, score_version, enrollment_id LIMIT 10))`,
          [event],
        );
      }
      await db.owner.query("ANALYZE t503_probe.entry");
    }, 180_000);
    afterAll(async () => {
      await db?.close();
    });

    it("retains actual completion entry1 -> exit2 -> entry3 before any drain", async () => {
      await complete(crossing, [10]);
      await complete(crossing, [8, 9]);
      await complete(crossing, [10]);
      const { rows } = await db.owner.query(
        `SELECT generation::integer, revision::integer, direction
        FROM t503_probe.fact WHERE event_id = $1 AND enrollment_id = $2 ORDER BY revision`,
        [crossing.event, crossing.participants[10]?.id],
      );
      expect(rows).toEqual([
        { generation: 1, revision: 1, direction: "entry" },
        { generation: 1, revision: 2, direction: "exit" },
        { generation: 1, revision: 3, direction: "entry" },
      ]);
      const latest = await db.owner.query(
        `SELECT fact.revision::integer FROM t503_probe.fact fact
        JOIN t503_probe.latest latest USING (event_id, enrollment_id, generation, revision)
        WHERE fact.event_id = $1 AND fact.enrollment_id = $2`,
        [crossing.event, crossing.participants[10]?.id],
      );
      expect(latest.rows).toEqual([{ revision: 3 }]);
    });

    it("rolls the full source, projection, revision and facts back together", async () => {
      const before = (
        await db.owner.query("SELECT * FROM t503_probe.state WHERE event_id = $1", [crossing.event])
      ).rows;
      await db.app.query("BEGIN");
      await source(crossing, 10);
      await db.app.query("SET CONSTRAINTS ALL IMMEDIATE");
      await db.app.query("ROLLBACK");
      expect(
        (
          await db.owner.query("SELECT * FROM t503_probe.state WHERE event_id = $1", [
            crossing.event,
          ])
        ).rows,
      ).toEqual(before);
      expect((await db.owner.query("SELECT * FROM t503_probe.dirty")).rows).toEqual([]);
    });

    it("keeps the private probe unavailable to outsiders and the API role", async () => {
      for (const client of [db.app, db.outsider]) {
        await expect(client.query("SELECT * FROM t503_probe.entry")).rejects.toMatchObject({
          code: "42501",
        });
        await expect(
          client.query("SELECT t503_probe.guard($1)", [hot.event]),
        ).rejects.toMatchObject({ code: "42501" });
      }
    });

    it("measures full source E residence against the non-negotiable <3ms gate", async () => {
      const latencies: number[] = [];
      for (let index = 120; index < 240; index += 1) {
        const started = performance.now();
        await complete(hot, [index]);
        if (index >= 140) latencies.push(performance.now() - started);
      }
      const { rows } = await db.owner.query<{ hold_lower_ms: number; wait_ms: number }>(
        `SELECT hold_lower_ms, wait_ms FROM t503_probe.measurement
         WHERE event_id = $1 ORDER BY transaction_id DESC LIMIT 100`,
        [hot.event],
      );
      const hold = stats(rows.map((row) => row.hold_lower_ms));
      process.stdout.write(
        "T503_GATE_EVIDENCE " +
          JSON.stringify({
            setup: {
              platform: platform(),
              release: release(),
              cpu: cpus()[0]?.model,
              threads: availableParallelism(),
              memoryGiB: totalmem() / 1024 ** 3,
              node: process.version,
              postgres: (await db.owner.query("SELECT version()")).rows,
              durability: (await db.owner.query("SHOW synchronous_commit")).rows,
            },
            members: 50_000,
            source: "actual complete_quest through 0081, no mock ledger",
            baselineClientMs: stats(baseline),
            candidateClientMs: stats(latencies),
            eventHoldLowerBoundMs: hold,
            combinedGateEventWaitMs: stats(rows.map((row) => row.wait_ms)),
            theoreticalUpperCompletionsPerMinute: 60_000 / hold.mean,
            gatePass: hold.mean < 3,
            targetPass: hold.mean <= 1.5,
            limitation:
              "hold ends before deferred-trigger return/WAL commit; actual residence is strictly longer",
          }) +
          "\n",
      );
      expect(
        hold.mean,
        "STOP: full-source serialized E lower bound must average <3ms",
      ).toBeLessThan(3);
    }, 120_000);
  });
