import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { pushFixture, type PushFixture } from "#test/support/push";
import { TEST_DATABASE_URL } from "#test/support/test-db";

const OUT = process.env["PUSH_TIMING"];
const MEMBERS = 50_000;
/** Leaders the board keeps out (an excluded email domain): the index walk must step over every one of them. */
const EXCLUDED_LEADERS = 300;
const LEFT_LEADERS = 300;
const say = (line: string) => appendFileSync(String(OUT), line + "\n");

async function seedCrowd(fixture: PushFixture): Promise<string> {
  const event = await fixture.newEvent({ phase: "live" });
  const tag = "rp_" + randomUUID().slice(0, 8) + "_";
  await fixture.owner(
    "INSERT INTO player (username) SELECT $1 || g FROM generate_series(1, $2) g",
    [tag, MEMBERS],
  );
  await fixture.owner(
    `INSERT INTO player_contact (player_id, email)
     SELECT id, username || '@' || CASE WHEN substr(username, length($1) + 1)::int <= $2 THEN 'excluded.test' ELSE 'perf.test' END
     FROM player WHERE left(username, length($1)) = $1`,
    [tag, EXCLUDED_LEADERS],
  );
  // Player g scores (MEMBERS - g) * 10 points: the excluded leaders are the first ones, then the left ones.
  await fixture.owner(
    `INSERT INTO enrollment (organizer_id, event_id, player_id, joined_at, status, score, balance, score_version)
     SELECT e.organizer_id, e.id, p.id, now() - interval '1 hour',
            CASE WHEN substr(p.username, length($2) + 1)::int BETWEEN $4 + 1 AND $4 + $5 THEN 'left' ELSE 'active' END,
            (($3 - substr(p.username, length($2) + 1)::int) * 10)::bigint + 10, 0,
            substr(p.username, length($2) + 1)::int
     FROM event e CROSS JOIN player p WHERE e.id = $1 AND left(p.username, length($2)) = $2`,
    [event, tag, MEMBERS, EXCLUDED_LEADERS, LEFT_LEADERS],
  );
  await fixture.owner(
    "INSERT INTO event_exclusion (organizer_id, event_id, kind, value) SELECT organizer_id, id, 'email_domain', 'excluded.test' FROM event WHERE id = $1",
    [event],
  );
  await fixture.owner("ANALYZE");
  return event;
}

async function timed<T>(work: () => Promise<T>): Promise<[T, number]> {
  const started = performance.now();
  const result = await work();
  return [result, performance.now() - started];
}

it.skipIf(OUT === undefined || TEST_DATABASE_URL === undefined)(
  "times one rank-push diff of an event of 50,000 members with 600 leaders the board keeps out",
  async () => {
    const fixture = await pushFixture();
    try {
      const event = await seedCrowd(fixture);
      const diff = () =>
        fixture.one<{ state: string; notices?: number }>(
          fixture.system,
          "SELECT rank_push_diff($1) AS r",
          [event],
        );
      const [baseline, baselineMs] = await timed(diff);
      expect(baseline.state).toBe("baseline");
      const [still, stillMs] = await timed(diff);
      expect(still).toEqual({ state: "diffed", notices: 0 });
      // The first player below the left leaders overtakes everyone: one entry and one exit, notices written.
      await fixture.owner(
        `UPDATE enrollment SET score = 99999999, score_version = 99999999
         WHERE id = (SELECT id FROM enrollment WHERE event_id = $1 AND status = 'active' AND score > 0
                     ORDER BY score LIMIT 1)`,
        [event],
      );
      const [moved, movedMs] = await timed(diff);
      expect(moved).toEqual({ state: "diffed", notices: 2 });
      const [listed, listMs] = await timed(() =>
        fixture.run<{ rank_push_events: string }>(
          fixture.system,
          "SELECT * FROM rank_push_events(1000)",
        ),
      );
      expect(listed.map((row) => row.rank_push_events)).toContain(event);
      const plan = await fixture.owner<{ "QUERY PLAN": string }>(
        `EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
         SELECT e.id FROM enrollment e
         WHERE e.event_id = $1 AND e.status = 'active' AND e.score > 0 AND ranking_eligible(e)
         ORDER BY e.score DESC, e.score_version LIMIT 10`,
        [event],
      );
      const lines = plan.map((row) => row["QUERY PLAN"]);
      say(
        "rank push " +
          MEMBERS +
          " members, " +
          EXCLUDED_LEADERS +
          " excluded and " +
          LEFT_LEADERS +
          " left leaders: baseline " +
          Math.round(baselineMs) +
          " ms, no change " +
          Math.round(stillMs) +
          " ms, entry and exit " +
          Math.round(movedMs) +
          " ms, live-event list " +
          Math.round(listMs) +
          " ms",
      );
      say("top-ten read plan: " + lines.filter((line) => /Scan|Execution/.test(line)).join(" | "));
      const slowest = Math.max(baselineMs, stillMs, movedMs);
      say("1 s per event gate: " + (slowest < 1000 ? "PASS" : "FAIL"));
      expect(lines.join("\n")).toMatch(/enrollment_ranking_idx/);
      expect(slowest).toBeLessThan(1000);
    } finally {
      await fixture.close();
    }
  },
  900_000,
);
