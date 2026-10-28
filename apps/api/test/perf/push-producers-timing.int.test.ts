import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { it } from "vitest";
import { pushFixture, type PushFixture } from "#test/support/push";
import { TEST_DATABASE_URL } from "#test/support/test-db";

/**
 * Times accept-all of 5,000 join requests with the join-decision trigger (T-501d, plan § Review 2, ADR-353 (5)): one
 * notice per acceptance, then the personal fan-out of them. The same door with the trigger switched off is timed for
 * the difference. Not an assertion (a timing check is flaky on a 2-core runner): run it by hand when the trigger, the
 * door or notice_create changes,
 * `PUSH_TIMING=/path/to/out.txt pnpm vitest run apps/api/test/perf/push-producers-timing.int.test.ts`.
 * Gate (plan): accept-all of 5,000 under 5 s with the trigger. The default suite proves the notices of 300
 * (`test/db/push-producers.int`).
 */
const OUT = process.env["PUSH_TIMING"];
const say = (line: string) => appendFileSync(String(OUT), `${line}\n`);
const REQUESTS = 5_000;

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

async function acceptAll(f: PushFixture, event: string): Promise<number> {
  const started = performance.now();
  await f.run(f.team(), "SELECT * FROM accept_all_join_requests($1, $2)", [event, randomUUID()]);
  return Math.round(performance.now() - started);
}

it.skipIf(OUT === undefined || TEST_DATABASE_URL === undefined)(
  "times accept-all of 5,000 requests with and without the join-decision trigger",
  async () => {
    const f = await pushFixture();
    try {
      const plain = await pending(f, REQUESTS);
      say(`T-501d: ${REQUESTS} requests written`);
      await f.owner("ALTER TABLE enrollment DISABLE TRIGGER enrollment_push_decision");
      const without = await acceptAll(f, plain);
      await f.owner("ALTER TABLE enrollment ENABLE TRIGGER enrollment_push_decision");
      const event = await pending(f, REQUESTS);
      const withTrigger = await acceptAll(f, event);
      const notices = await f.count("notice WHERE event_id = $1 AND kind = 'join_accepted'", [
        event,
      ]);
      const started = performance.now();
      const rows = await f.fanOut();
      const fanned = Math.round(performance.now() - started);
      say(
        `T-501d accept-all of ${REQUESTS}: ${withTrigger} ms with the trigger (${notices} notices), ` +
          `${without} ms without; personal fan-out of them: ${fanned} ms (${rows} center rows)`,
      );
    } finally {
      await f.close();
    }
  },
  600_000,
);
