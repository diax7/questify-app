import { appendFileSync } from "node:fs";
import { it } from "vitest";
import { questifyFixture } from "#test/support/questify";
import { TEST_DATABASE_URL } from "#test/support/test-db";

/**
 * Times the ranking read's own row (`ownIn` in `src/ranking/ranking.ts`) with `own_level(NULL)` (before FOLLOWUPS
 * batch 30), with `own_level_only()` (migration 0182) and with no level at all (`bare`, the read before ADR-766),
 * alternating on one database, on an event of 50,000 players with XP spread over the levels, as the API's role with the
 * reader's context. Median and 90th percentile of 350 calls each, and the shared buffers of one call
 * (`EXPLAIN (ANALYZE, BUFFERS)`). Not an assertion: run it by hand,
 * `OWN_LEVEL_TIMING=/path/to/out.txt pnpm vitest run apps/api/test/perf/own-level-timing.int.test.ts`.
 */
const OUT = process.env["OWN_LEVEL_TIMING"];
const say = (line: string) => appendFileSync(String(OUT), `${line}\n`);
const PLAYERS = 50_000;
const RUNS = 350;

const ownRow = (level: string) =>
  `SELECT e.id, e.score, p.username, p.avatar, c.equipment, l.level FROM enrollment e JOIN player p ON p.id = e.player_id
   CROSS JOIN own_equipment() c CROSS JOIN ${level}
   WHERE e.event_id = $1 AND e.player_id = $2 AND e.status = 'active'${level.startsWith("own_level_only") ? " AND l.level IS NOT NULL" : ""}`;
const READS = {
  before: ownRow("own_level(NULL) l"),
  after: ownRow("own_level_only() l(level)"),
  bare: ownRow("(SELECT 1::smallint AS level) l"),
};
const NAMES = ["before", "after", "bare"] as const;

it.skipIf(OUT === undefined || TEST_DATABASE_URL === undefined)(
  "times the ranking read's own row with own_level(NULL) and own_level_only()",
  async () => {
    const f = await questifyFixture();
    try {
      const event = await f.newEvent({ phase: "live" });
      const q = (sql: string, values: unknown[] = []) => f.db.owner.query(sql, values);
      await q("INSERT INTO player (username) SELECT 'ol_' || n FROM generate_series(1, $1) n", [
        PLAYERS,
      ]);
      await q(
        `UPDATE player_xp x SET xp = (random() * 60000)::bigint FROM player p
         WHERE p.id = x.player_id AND p.username LIKE 'ol\\_%'`,
      );
      await q(
        `INSERT INTO enrollment (organizer_id, event_id, player_id, score, balance)
         SELECT e.organizer_id, e.id, p.id, (random() * 1000)::int, 0 FROM event e
         CROSS JOIN player p WHERE e.id = $1 AND p.username LIKE 'ol\\_%'`,
        [event],
      );
      await q("ANALYZE");
      const [reader] = await f.owner<{ id: string }>(
        "SELECT id FROM player WHERE username = 'ol_25000'",
      );
      const player = reader?.id ?? "";
      const times: Record<keyof typeof READS, number[]> = { before: [], after: [], bare: [] };
      for (let run = 0; run < RUNS + 20; run += 1) {
        for (const name of NAMES) {
          const started = performance.now();
          await f.asPlayer(player, READS[name], [event, player]);
          if (run >= 20) times[name].push(performance.now() - started);
        }
      }
      for (const name of NAMES) {
        const [plan] = await f.asPlayer<{ "QUERY PLAN": [Record<string, unknown>] }>(
          player,
          `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${READS[name]}`,
          [event, player],
        );
        const top = plan?.["QUERY PLAN"][0] as {
          Plan: { "Shared Hit Blocks": number; "Shared Read Blocks": number };
          "Execution Time": number;
        };
        const sorted = times[name].toSorted((a, b) => a - b);
        const at = (share: number) =>
          (sorted[Math.floor(share * (sorted.length - 1))] ?? 0).toFixed(2);
        say(
          `${name}: median ${at(0.5)} ms, p90 ${at(0.9)} ms of ${RUNS} (wall, as the API's role); ` +
            `buffers ${top.Plan["Shared Hit Blocks"] + top.Plan["Shared Read Blocks"]}, ` +
            `db ${top["Execution Time"].toFixed(3)} ms`,
        );
      }
    } finally {
      await f.close();
    }
  },
  600_000,
);
