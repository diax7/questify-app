import { appendFileSync } from "node:fs";
import { loadavg } from "node:os";
import { it } from "vitest";
import { OLD_USERNAME_BLOCKED, comparedNames } from "#test/db/username-blocked-names";
import { TEST_DATABASE_URL, createTestDatabase } from "#test/support/test-db";

/**
 * Times `username_blocked` as 0118 had it (SQL, its CTEs inlined into the list scan) and as 0179 has it (PL/pgSQL, the
 * name folded once), per call over the compared names, and the rename door that runs it (the register path's check), with
 * each version in place by turns. Not an assertion: a timing check is flaky on a shared runner. Run by hand:
 * `USERNAME_TIMING=/path/to/out.txt pnpm vitest run apps/api/test/perf/username-timing`. Each figure is the median of 15
 * rounds after 3 warm-ups.
 */
const OUT = process.env["USERNAME_TIMING"];
const say = (line: string) => appendFileSync(String(OUT), `${line}\n`);
const ROUNDS = 15;
const WARM = 3;
const BATCH = 2000;
const DOOR_CALLS = 200;

const median = (values: number[]): number => {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

it.skipIf(OUT === undefined || TEST_DATABASE_URL === undefined)(
  "times username_blocked and the rename door before and after 0179",
  async () => {
    const db = await createTestDatabase();
    try {
      const q = (sql: string, values: unknown[] = []) => db.owner.query(sql, values);
      await q(OLD_USERNAME_BLOCKED);
      const fresh = (
        await q("SELECT pg_get_functiondef('username_blocked(text)'::regprocedure) AS def")
      ).rows[0].def as string;
      const old = OLD_USERNAME_BLOCKED.replace("old_username_blocked", "username_blocked");
      const words = (await q("SELECT word FROM username_word")).rows.map((r) => r.word as string);
      const names = comparedNames(words, 4000);
      const batch = names.filter((_, n) => n % Math.ceil(names.length / BATCH) === 0);
      say(
        `names compared: ${names.length}; timed batch: ${batch.length}; list words: ${words.length}`,
      );

      const player = (await q("INSERT INTO player (username) VALUES ('timer_0') RETURNING id"))
        .rows[0].id as string;
      const doorNames = names
        .filter((name) => /^[ء-غف-يA-Za-z0-9_]{3,30}$/u.test(name))
        .slice(0, DOOR_CALLS);
      const perCall = async (fn: string) => {
        const plan = (
          await q(
            `EXPLAIN (ANALYZE, FORMAT JSON) SELECT count(*) FROM unnest($1::text[]) n WHERE ${fn}(n)`,
            [batch],
          )
        ).rows[0]["QUERY PLAN"][0] as { "Execution Time": number };
        return plan["Execution Time"] / batch.length;
      };
      const door = async () => {
        const times: number[] = [];
        for (const name of doorNames) {
          await q("BEGIN");
          await q("SELECT set_config('app.player_id', $1, true)", [player]);
          const started = performance.now();
          await q("SELECT * FROM rename_player($1, 30)", [name]);
          times.push(performance.now() - started);
          await q("ROLLBACK");
        }
        return median(times);
      };

      const result: Record<string, number[]> = { old: [], new: [], doorOld: [], doorNew: [] };
      for (let round = 0; round < ROUNDS + WARM; round += 1) {
        await q(old);
        const callOld = await perCall("username_blocked");
        const doorOld = await door();
        await q(fresh);
        const callNew = await perCall("username_blocked");
        const doorNew = await door();
        if (round >= WARM) {
          result["old"]?.push(callOld);
          result["new"]?.push(callNew);
          result["doorOld"]?.push(doorOld);
          result["doorNew"]?.push(doorNew);
        }
      }
      const load = loadavg()[0]?.toFixed(1);
      say(
        `username_blocked ms a call: 0118 ${median(result["old"] ?? []).toFixed(3)}, 0179 ${median(result["new"] ?? []).toFixed(3)}`,
      );
      say(
        `rename_player ms a call (client side, ${doorNames.length} names): 0118 ${median(result["doorOld"] ?? []).toFixed(3)}, 0179 ${median(result["doorNew"] ?? []).toFixed(3)} (load ${load})`,
      );
    } finally {
      await db.close();
    }
  },
  600_000,
);
