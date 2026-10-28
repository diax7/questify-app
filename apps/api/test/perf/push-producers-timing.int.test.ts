import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { it } from "vitest";
import { pushFixture, type PushFixture } from "#test/support/push";
import { TEST_DATABASE_URL } from "#test/support/test-db";

/**
 * Times one accept-all call with the join-decision trigger (T-501d, plan § Review 2, ADR-353 (5)): the door takes at
 * most 1,000 requests a call, so with 5,000 waiting one call accepts 1,000 and writes 1,000 notices; then the personal
 * fan-out of them. The same call with the trigger switched off is timed for the difference. Not an assertion (a timing
 * check is flaky on a 2-core runner): run it by hand when the trigger, the door, the other `enrollment` triggers or
 * notice_create changes,
 * `PUSH_TIMING=/path/to/out.txt pnpm vitest run apps/api/test/perf/push-producers-timing.int.test.ts`.
 * Gate: one call of 1,000 under 5 s (the API's statement limit) with the trigger. The default suite proves the cap
 * (1,001 requests give 1,000 then 1, `test/db/push-producers.int`).
 */
const OUT = process.env["PUSH_TIMING"];
const say = (line: string) => appendFileSync(String(OUT), `${line}\n`);
const WAITING = 5_000;

/** A private event with `n` pending requests; answers the event. */
async function pending(f: PushFixture, n: number): Promise<string> {
  const event = await f.newEvent({ phase: "live", access: "private" });
  const tag = randomUUID().slice(0, 8);
  await f.owner(
    `WITH p AS (INSERT INTO player (username) SELECT 'tp_' || $2 || '_' || g FROM generate_series(1, $3) g
                RETURNING id)
     INSERT INTO enrollment (organizer_id, event_id, player_id, status)
     SELECT e.organizer_id, e.id, p.id, 'pending' FROM p CROSS JOIN event e WHERE e.id = $1`,
    [event, tag, n],
  );
  await f.owner("ANALYZE enrollment");
  return event;
}

/** One accept-all call: its time and what it answered. */
async function oneCall(f: PushFixture, event: string) {
  const started = performance.now();
  const [row] = await f.run<{ accepted: number; remaining: number }>(
    f.team(),
    "SELECT * FROM accept_all_join_requests($1, $2)",
    [event, randomUUID()],
  );
  return { ms: Math.round(performance.now() - started), ...row };
}

it.skipIf(OUT === undefined || TEST_DATABASE_URL === undefined)(
  "times one accept-all call of 1,000 with and without the join-decision trigger",
  async () => {
    const f = await pushFixture();
    try {
      const plain = await pending(f, WAITING);
      await f.owner("ALTER TABLE enrollment DISABLE TRIGGER enrollment_push_decision");
      const without = await oneCall(f, plain);
      await f.owner("ALTER TABLE enrollment ENABLE TRIGGER enrollment_push_decision");
      const event = await pending(f, WAITING);
      const withTrigger = await oneCall(f, event);
      const notices = await f.count("notice WHERE event_id = $1 AND kind = 'join_accepted'", [
        event,
      ]);
      const started = performance.now();
      const rows = await f.fanOut();
      const fanned = Math.round(performance.now() - started);
      say(
        `T-501d one accept-all call with ${WAITING} waiting: ${withTrigger.ms} ms with the trigger ` +
          `(accepted ${withTrigger.accepted}, remaining ${withTrigger.remaining}, ${notices} notices), ` +
          `${without.ms} ms without; personal fan-out of them: ${fanned} ms (${rows} center rows)`,
      );
    } finally {
      await f.close();
    }
  },
  600_000,
);
