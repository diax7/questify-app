import { appendFileSync } from "node:fs";
import { it } from "vitest";
import { TEST_DATABASE_URL, createTestDatabase } from "#test/support/test-db";

/**
 * Times one event insert with 0009's time zone guard (a `pg_timezone_names` lookup) and with 0180's (the copy in
 * `timezone_name`), and the insert with the guard off as the floor. Not an assertion: a timing check is flaky on a shared
 * runner. Run by hand: `EVENT_TIMEZONE_TIMING=/path/to/out.txt pnpm vitest run apps/api/test/perf/event-timezone-timing`.
 * Each figure is the median of 5 rounds of 100 single-row inserts, one statement each, the three versions by turns.
 */
const OUT = process.env["EVENT_TIMEZONE_TIMING"];
const say = (line: string) => appendFileSync(String(OUT), `${line}\n`);
const ROUNDS = 5;
const INSERTS = 100;

/** 0009's guard, as it was deployed. */
const OLD_GUARD = `
CREATE OR REPLACE FUNCTION old_timezone_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = NEW.timezone) THEN
    RAISE EXCEPTION 'unknown time zone' USING ERRCODE = 'QE422';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER old_timezone_guard BEFORE INSERT OR UPDATE OF timezone ON event
  FOR EACH ROW EXECUTE FUNCTION old_timezone_guard();
ALTER TABLE event DISABLE TRIGGER old_timezone_guard;`;

const median = (values: number[]): number => {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

it.skipIf(TEST_DATABASE_URL === undefined || OUT === undefined)(
  "times an event insert under 0009's and 0180's time zone guard",
  { timeout: 600_000 },
  async () => {
    const db = await createTestDatabase();
    try {
      const q = (sql: string, values: unknown[] = []) => db.owner.query(sql, values);
      await q(OLD_GUARD);
      const org = (
        await q("INSERT INTO organizer (name, slug) VALUES ('Zone', 'zone') RETURNING id")
      ).rows[0] as { id: string };
      let made = 0;
      const round = async (): Promise<number> => {
        const start = performance.now();
        for (let i = 0; i < INSERTS; i += 1) {
          made += 1;
          await q(
            "INSERT INTO event (organizer_id, join_code, name_en, timezone) VALUES ($1, $2, 'Z', 'Asia/Riyadh')",
            [org.id, `TZ${String(made).padStart(4, "0")}`],
          );
        }
        return (performance.now() - start) / INSERTS;
      };
      const versions = {
        "0009 (pg_timezone_names)": ["old_timezone_guard", "event_timezone_guard"],
        "0180 (timezone_name copy)": ["event_timezone_guard", "old_timezone_guard"],
        "no guard": [null, "event_timezone_guard"],
      } as const;
      const times: Record<string, number[]> = {};
      await round();
      for (let r = 0; r < ROUNDS; r += 1) {
        for (const [label, [on, off]] of Object.entries(versions)) {
          await q(`ALTER TABLE event DISABLE TRIGGER ${off}`);
          await q("ALTER TABLE event DISABLE TRIGGER old_timezone_guard");
          if (on !== null) await q(`ALTER TABLE event ENABLE TRIGGER ${on}`);
          (times[label] ??= []).push(await round());
        }
      }
      await q("ALTER TABLE event ENABLE TRIGGER event_timezone_guard");
      say(`event insert, ms each (median of ${ROUNDS} rounds of ${INSERTS}):`);
      for (const [label, values] of Object.entries(times)) {
        say(
          `  ${label}: ${median(values).toFixed(2)} ms (${values.map((v) => v.toFixed(2)).join(", ")})`,
        );
      }
    } finally {
      await db.close();
    }
  },
);
