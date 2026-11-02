import { appendFileSync } from "node:fs";
import { it } from "vitest";
import { questifyFixture } from "#test/support/questify";
import { connectAsOwner, TEST_DATABASE_URL } from "#test/support/test-db";

/**
 * Times the XP table door on a 300,000-player board (XP spread 1 to 40,000, so levels 28 to 30 are unreached) (T-709d, plan "Tests" 9, Q-401): a 100-level save with every kind of
 * change (starts raised and lowered, a reward remapped, 70 levels added), then a save that removes those 70 again (each
 * removal probes level_reached and the board); the lock-holding time of a save with a scan queued behind it; and the
 * preview. Not an assertion (timing is flaky on a 2-core runner); run by hand:
 * `XP_TABLE_TIMING=/path/out.txt npx vitest run apps/api/test/perf/xp-table-timing.int.test.ts`. The result and the
 * machine are recorded in Q-401.
 */
const OUT = process.env["XP_TABLE_TIMING"];
const PLAYERS = 300_000;
const REACHED_PLAYERS = 50_000;
const say = (line: string) => appendFileSync(String(OUT), `${line}\n`);

type Level = { level: number; xpFrom: number; itemId: string | null };

it.skipIf(OUT === undefined || TEST_DATABASE_URL === undefined)(
  "times the XP table door, a scan queued behind it and the preview at 300,000 players",
  async () => {
    const f = await questifyFixture();
    const owner = await connectAsOwner(f.db);
    const watcher = await connectAsOwner(f.db);
    try {
      const [staff] = await f.owner<{ id: string }>(
        "INSERT INTO staff_user (email, password_hash, platform_role, status) VALUES ('t@questify.test', 'h', 'admin', 'active') RETURNING id",
      );
      const admin = { isAdmin: true, staffUserId: staff?.id ?? "" };
      const scanner = await f.newPlayer();
      const event = await f.newEvent({ phase: "live" });
      const enrollment = await f.join(event, scanner);
      await f.earn(event, enrollment);
      // The board and the reached levels straight from a seeded spread; the door reads them, never the ledger.
      await f.owner("SET session_replication_role = replica");
      await f.owner(
        "INSERT INTO player (id, username) SELECT gen_random_uuid(), 'xt_' || n FROM generate_series(1, $1::int) n",
        [PLAYERS],
      );
      await f.owner(
        `INSERT INTO xp_board (board, player_id, xp, xp_version)
         SELECT 'all', p.id, 1 + (split_part(p.username, '_', 2)::bigint * 7919) % 40000, 1
         FROM player p WHERE p.username LIKE 'xt\\_%'`,
      );
      const entry = (await f.owner<{ id: string }>("SELECT min(id) AS id FROM xp_entry"))[0]?.id;
      await f.owner(
        `INSERT INTO level_reached (player_id, level, xp_entry_id)
         SELECT b.player_id, l.level, $2 FROM xp_board b JOIN player p ON p.id = b.player_id
         JOIN xp_level l ON l.level > 1 AND l.xp_from <= b.xp
         WHERE b.board = 'all' AND p.username LIKE 'xt\\_%' AND split_part(p.username, '_', 2)::int <= $1`,
        [REACHED_PLAYERS, entry],
      );
      await f.owner(
        `INSERT INTO item (id, kind, name_ar, name_en) SELECT 'xt-' || n, 'title', 'جائزة', 'Prize'
         FROM generate_series(31, 100) n`,
      );
      await f.owner("SET session_replication_role = origin");
      await f.owner("VACUUM ANALYZE");
      const shipped = (
        await f.run<{ r: { levels: (Level & { reached: boolean })[] } }>(
          admin,
          "SELECT admin_xp_table() AS r",
        )
      )[0]?.r.levels.map(({ level, xpFrom, itemId }) => ({ level, xpFrom, itemId })) as Level[];
      const big: Level[] = [
        ...shipped.map((row) => {
          if (row.level === 5) return { ...row, xpFrom: row.xpFrom - 100 };
          if (row.level === 29) return { ...row, xpFrom: row.xpFrom + 50 };
          if (row.level === 30) return { ...row, xpFrom: row.xpFrom + 100, itemId: "xt-100" };
          return row;
        }),
        ...Array.from({ length: 70 }, (_, index) => ({
          level: 31 + index,
          xpFrom: 60_000 + index * 1000,
          itemId: index === 69 ? "level-30" : `xt-${31 + index}`,
        })),
      ];
      const timed = async (label: string, sql: string, values: unknown[]) => {
        const started = performance.now();
        await f.run(admin, sql, values);
        say(`${label}: ${(performance.now() - started).toFixed(1)} ms`);
      };
      const save = "SELECT admin_xp_table_save($1, NULL, true, gen_random_uuid())";
      await timed("preview of the 100-level table", "SELECT admin_xp_table_preview($1)", [
        { levels: big },
      ]);
      await timed("save 30 -> 100 levels, every kind of change", save, [{ levels: big }]);
      await timed("save 100 -> 30 levels (70 removals probed)", save, [{ levels: shipped }]);

      await owner.query("BEGIN");
      await owner.query(
        "SELECT set_config('app.is_admin', 'on', true), set_config('app.staff_user_id', $1, true)",
        [admin.staffUserId],
      );
      const held = performance.now();
      await owner.query(save, [{ levels: big }]);
      const statement = performance.now() - held;
      const scanStart = performance.now();
      const scan = f.earn(event, enrollment).then(() => performance.now() - scanStart);
      for (let tries = 0; tries < 200; tries += 1) {
        const { rows } = await watcher.query(
          "SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE 'INSERT INTO ledger_entry%'",
        );
        if (rows.length > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await owner.query("COMMIT");
      const heldFor = performance.now() - held;
      say(
        `save with a scan queued: statement ${statement.toFixed(1)} ms, locks held ${heldFor.toFixed(1)} ms, scan done in ${(await scan).toFixed(1)} ms`,
      );
    } finally {
      await owner.end();
      await watcher.end();
      await f.close();
    }
  },
  1_200_000,
);
