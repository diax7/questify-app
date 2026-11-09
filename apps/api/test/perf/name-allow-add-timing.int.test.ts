import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { ABUSIVE_NAMES } from "#test/db/full-name-corpus";
import { TEST_DATABASE_URL, createTestDatabase } from "#test/support/test-db";

/**
 * Times the allow-list's add door (`admin_name_allow_add`, 0185, restated by 0186) and holds it to the "under 50 ms" its
 * comment in 0186 claims. The words are the whole words and the 3- and 4-letter openings of the abusive names of the
 * corpus, so many of them hold probes and the door checks those (before the insert and after it); each call is one
 * statement, answered "added", "exists" or refused (WA422 and WA409 cost the same checks). The median and the 95th
 * percentile are asserted, the slowest is only written. Timing is flaky on a busy runner, so it is a hand-run test, not a
 * CI one: `ALLOW_ADD_TIMING=/path/to/out.txt pnpm vitest run apps/api/test/perf/name-allow-add-timing`.
 */
const OUT = process.env["ALLOW_ADD_TIMING"];
const say = (line: string) => appendFileSync(String(OUT), `${line}\n`);
const LIMIT_MS = 50;
const CALLS = 300;
const WARM = 10;

const quantile = (values: number[], at: number): number => {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * at))] ?? 0;
};

/** Whole words and short openings of the abusive names, spread evenly, at most `CALLS + WARM` of them. */
function wordsToTry(): string[] {
  const all = new Set<string>();
  for (const name of ABUSIVE_NAMES) {
    for (const token of name.toLowerCase().split(/[^a-zء-غف-ي]+/u)) {
      if (token.length >= 3) {
        all.add(token);
        all.add(token.slice(0, 3));
        all.add(token.slice(0, 4));
      }
    }
  }
  const list = [...all].filter((word) => word.length >= 3);
  const step = Math.max(1, Math.floor(list.length / (CALLS + WARM)));
  return list.filter((_word, n) => n % step === 0).slice(0, CALLS + WARM);
}

it.skipIf(OUT === undefined || TEST_DATABASE_URL === undefined)(
  "answers an add of the allow-list in under 50 ms",
  async () => {
    const db = await createTestDatabase();
    try {
      const q = (sql: string, values: unknown[] = []) => db.owner.query(sql, values);
      const admin = (
        await q(
          `INSERT INTO staff_user (email, password_hash, platform_role, status)
           VALUES ('timing-allow@questify.test', 'h', 'admin', 'active') RETURNING id`,
        )
      ).rows[0].id as string;
      await q(
        "SELECT set_config('app.is_admin', 'on', false), set_config('app.staff_user_id', $1, false)",
        [admin],
      );
      await q("ANALYZE");
      const words = wordsToTry();
      const answers: Record<string, number> = {};
      const times: number[] = [];
      for (const [n, word] of words.entries()) {
        const start = performance.now();
        const answer = await q("SELECT admin_name_allow_add($1, $2) AS r", [
          word,
          randomUUID(),
        ]).then(
          (result) => String((result.rows[0].r as { outcome: string }).outcome),
          (error: unknown) => String((error as { code?: string }).code),
        );
        const took = performance.now() - start;
        if (n >= WARM) {
          times.push(took);
          answers[answer] = (answers[answer] ?? 0) + 1;
        }
      }
      const median = quantile(times, 0.5);
      const p95 = quantile(times, 0.95);
      say(
        `add door: ${times.length} calls (${JSON.stringify(answers)}), median ${median.toFixed(1)} ms, ` +
          `95th percentile ${p95.toFixed(1)} ms, slowest ${Math.max(...times).toFixed(1)} ms`,
      );
      expect(times.length).toBeGreaterThanOrEqual(100);
      expect(median).toBeLessThan(LIMIT_MS);
      expect(p95).toBeLessThan(LIMIT_MS);
    } finally {
      await db.close();
    }
  },
  600_000,
);
