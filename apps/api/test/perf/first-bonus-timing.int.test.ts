import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { expect, it } from "vitest";
import { withRequestContext } from "#src/db/context";
import {
  TEST_DATABASE_URL,
  addMember,
  createTestDatabase,
  seedTwoTenants,
} from "#test/support/test-db";

/**
 * Times the first-N bonus's claim at the entrance burst (T-313, ADR-260, CTO 8): 300 completions at once on one quest
 * with N = 50, from two API-like pools of 10 connections each (config.ts's default, two instances), against the same
 * burst on a quest without a bonus and on one whose bonus is used up. Each burst runs in a fresh event of the same
 * size, the order alternates, and the medians over the rounds are compared. Not an assertion on time (a timing check
 * is flaky on a 2-core runner): run it by hand when the claim changes,
 * `FIRST_BONUS_TIMING=/path/to/out.txt pnpm vitest run apps/api/test/perf/first-bonus-timing.int.test.ts`.
 * Target (plan): exactly 50 paid, and the bonus burst's p95 within 20% of the plain one.
 */
const OUT = process.env["FIRST_BONUS_TIMING"];
const say = (line: string) => appendFileSync(String(OUT), `${line}\n`);
const BURST = 300;
const ROUNDS = 6;

type Kind = "plain" | "bonus" | "used_up";

const percentile = (times: readonly number[], share: number) => {
  const sorted = times.toSorted((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * share) - 1)] ?? 0;
};

/** One completion through `pool`, as the API runs it: its time in ms. */
const complete = async (pool: Pool, player: string, quest: string) => {
  const client = await pool.connect();
  const started = performance.now();
  try {
    await withRequestContext(client, { playerId: player }, () =>
      client.query("SELECT * FROM complete_quest($1, 'qr', 1, NULL, $2, NULL)", [
        quest,
        randomUUID(),
      ]),
    );
  } finally {
    client.release();
  }
  return performance.now() - started;
};

it.skipIf(OUT === undefined || TEST_DATABASE_URL === undefined)(
  "times 300 completions at once on a bonus quest (N = 50) against a plain one",
  async () => {
    const db = await createTestDatabase();
    const pools = [
      new Pool({ connectionString: db.appUrl, max: 10 }),
      new Pool({ connectionString: db.appUrl, max: 10 }),
    ];
    let counter = 0;
    try {
      const ids = await seedTwoTenants(db.owner);
      const staff = await addMember(db.owner, ids.orgA, "owner");
      const q = (sql: string, values: unknown[] = []) => db.owner.query(sql, values);
      const setBonus = async (event: string, quest: string, slots: number) => {
        const client = await (pools[0] as Pool).connect();
        try {
          await withRequestContext(client, { organizerId: ids.orgA, staffUserId: staff }, () =>
            client.query("SELECT set_quest_first_bonus($1, $2, 25, $3, $4)", [
              event,
              quest,
              slots,
              randomUUID(),
            ]),
          );
        } finally {
          client.release();
        }
      };
      /** One burst in a fresh live event with BURST members: the plain quest, the bonus, or a used-up bonus. */
      const burst = async (kind: Kind) => {
        counter += 1;
        const event = (
          await q(
            `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at)
             VALUES ($1, $2, 'Gate Fest', 'live', now() - interval '1 hour', now() + interval '1 day')
             RETURNING id`,
            [ids.orgA, `FBT${counter}`],
          )
        ).rows[0].id;
        const category = (
          await q("INSERT INTO category (event_id, name_en) VALUES ($1, 'Gate') RETURNING id", [
            event,
          ])
        ).rows[0].id;
        const quest = (
          await q(
            `INSERT INTO quest (event_id, category_id, type, title_en, points, repeat_cap)
             VALUES ($1, $2, 'scan_qr', 'Entrance', 10, 1) RETURNING id`,
            [event, category],
          )
        ).rows[0].id;
        const players = (
          await q(
            `WITH p AS (INSERT INTO player (username)
                        SELECT 'fbt_' || $1 || '_' || n FROM generate_series(1, ${BURST + 1}) n RETURNING id)
             INSERT INTO enrollment (organizer_id, event_id, player_id) SELECT $2, $3, p.id FROM p
             RETURNING player_id`,
            [counter, ids.orgA, event],
          )
        ).rows.map((row: { player_id: string }) => row.player_id);
        const first = players.pop() as string;
        if (kind !== "plain") {
          await setBonus(event, quest, kind === "bonus" ? 50 : 1);
        }
        if (kind === "used_up") {
          await complete(pools[0] as Pool, first, quest);
        }
        await q("ANALYZE quest_completion, ledger_entry, enrollment, quest_bonus_slot");
        const times = await Promise.all(
          players.map((player: string, index: number) =>
            complete(pools[index % 2] as Pool, player, quest),
          ),
        );
        const paid = (
          await q(
            "SELECT count(*)::int AS n FROM ledger_entry WHERE quest_id = $1 AND kind = 'first_bonus'",
            [quest],
          )
        ).rows[0].n;
        return { p50: percentile(times, 0.5), p95: percentile(times, 0.95), paid };
      };
      const results: Record<Kind, { p50: number; p95: number }[]> = {
        plain: [],
        bonus: [],
        used_up: [],
      };
      const orders: readonly (readonly Kind[])[] = [
        ["plain", "bonus", "used_up"],
        ["bonus", "used_up", "plain"],
        ["used_up", "plain", "bonus"],
      ];
      await burst("plain");
      for (let round = 0; round < ROUNDS; round += 1) {
        for (const kind of orders[round % orders.length] ?? []) {
          const result = await burst(kind);
          if (kind === "bonus") {
            expect(result.paid).toBe(50);
          }
          results[kind].push(result);
        }
      }
      const median = (values: readonly number[]) => percentile(values, 0.5);
      for (const kind of ["plain", "bonus", "used_up"] as const) {
        say(
          `first-N bonus timing, ${kind}: p95 per round ${results[kind].map((r) => r.p95.toFixed(0)).join(", ")} ms;` +
            ` median p95 ${median(results[kind].map((r) => r.p95)).toFixed(1)} ms,` +
            ` median p50 ${median(results[kind].map((r) => r.p50)).toFixed(1)} ms`,
        );
      }
      const plain = median(results.plain.map((r) => r.p95));
      const bonus = median(results.bonus.map((r) => r.p95));
      say(
        `first-N bonus timing: bonus/plain median p95 ${((bonus / plain - 1) * 100).toFixed(1)}%`,
      );
    } finally {
      await Promise.all(pools.map((pool) => pool.end()));
      await db.close();
    }
  },
  600_000,
);
