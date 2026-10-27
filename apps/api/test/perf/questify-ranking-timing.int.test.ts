import { appendFileSync } from "node:fs";
import { it } from "vitest";
import { withRequestContext } from "#src/db/context";
import { TEST_DATABASE_URL, createTestDatabase } from "#test/support/test-db";

/**
 * Times the Questify-wide ranking door for the last-placed reader at 100,000 ranked players on both boards (T-408,
 * ADR-322, plan review item 3): after ANALYZE, 200 calls per board, p95. The gate is 50 ms; over it, the fallback is
 * an index-only count of the rows ahead minus the inactive players ahead. Not an assertion (timing is flaky on a 2-core
 * runner); run by hand: `QUESTIFY_RANKING_TIMING=/path/out.txt npx vitest run apps/api/test/perf`. The result and the
 * machine are recorded in ADR-322.
 */
const OUT = process.env["QUESTIFY_RANKING_TIMING"];
const PLAYERS = 100_000;
const CALLS = 200;
const say = (line: string) => appendFileSync(String(OUT), `${line}\n`);

it.skipIf(OUT === undefined || TEST_DATABASE_URL === undefined)(
  "times questify_ranking for the last-placed reader at 100,000 players",
  async () => {
    const db = await createTestDatabase();
    try {
      const q = (sql: string, values: unknown[] = []) => db.owner.query(sql, values);
      await q(
        "INSERT INTO player (username) SELECT 'qr_' || n FROM generate_series(1, $1::int) n",
        [PLAYERS],
      );
      // Boards straight from a seeded order: the door reads the boards only, never the ledger.
      await q(
        `INSERT INTO xp_board (board, player_id, xp, xp_version)
         SELECT b.board, p.id, 1 + (split_part(p.username, '_', 2)::int * 7919) % 5000,
                split_part(p.username, '_', 2)::bigint
         FROM player p CROSS JOIN (VALUES ('all'), (questify_month(now()))) b(board)
         WHERE p.username LIKE 'qr\\_%'`,
      );
      await q(
        "UPDATE player SET status = 'banned' WHERE username LIKE 'qr\\_%' AND random() < 0.01",
      );
      await q("VACUUM ANALYZE");
      for (const scope of ["lifetime", "month"]) {
        const board = scope === "lifetime" ? "all" : null;
        const last = (
          await q(
            `SELECT b.player_id FROM xp_board b JOIN player p ON p.id = b.player_id
             WHERE b.board = coalesce($1, questify_month(now())) AND p.status = 'active'
             ORDER BY b.xp, b.xp_version DESC LIMIT 1`,
            [board],
          )
        ).rows[0].player_id as string;
        const times: number[] = [];
        let rank = 0;
        await withRequestContext(db.app, { playerId: last }, async () => {
          for (let i = 0; i < CALLS; i += 1) {
            const start = performance.now();
            const { rows } = await db.app.query("SELECT questify_ranking($1) AS r", [scope]);
            times.push(performance.now() - start);
            rank = rows[0].r.me.rank as number;
          }
        });
        times.sort((a, b) => a - b);
        const p95 = times[Math.ceil(CALLS * 0.95) - 1] ?? 0;
        say(
          `${scope}: ${PLAYERS} players, reader rank ${rank}, p50 ${times[CALLS / 2]?.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms`,
        );
      }
    } finally {
      await db.close();
    }
  },
  600_000,
);
