import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { it } from "vitest";
import { pushFixture, type PushFixture } from "#test/support/push";
import { TEST_DATABASE_URL } from "#test/support/test-db";

/**
 * Times the event pushes' fan-out and claim at the plan's size (T-501e, ADR-354 (5), (7), (9)), 50,000 active members
 * with 1.2 devices each (60,000 sends): a live poll (every member checked for the quest it names, for being allowed to
 * play and for not having voted), then a category's opening whose category gains a 20-quest gate after the fan-out
 * (the claim must not check the gate per member) and an opening notice of that gated category (the fan-out must not
 * either). Not an assertion (a timing check is flaky on a 2-core runner), like the other timing files: run it by hand
 * when the event pushes' audience rules or the fan-out change,
 * `PUSH_TIMING=/path/to/out.txt pnpm vitest run apps/api/test/perf/push-event-timing.int.test.ts`.
 * Gates (T-501 plan, batches of 1,000 since T-501e): each fan-out call under 1 s and the whole under 30 s on the
 * laptop; claim plus ack of 200 under 200 ms with the queue present (the claim checks each row again).
 */
const OUT = process.env["PUSH_TIMING"];
const say = (line: string) => appendFileSync(String(OUT), `${line}\n`);
const MEMBERS = 50_000;
const GATE_QUESTS = 20;
const CLEARED = 2_000;
const LIVE_POLL = {
  options: [
    { id: "a", text: { en: "Robots" } },
    { id: "b", text: { en: "Space" } },
  ],
  live: { choices: "one", results: "after_vote", minutes: 30 },
};

const ms = (value: number | undefined) => Math.round(value ?? 0);

/** A live event with MEMBERS members, each signed in on one iOS phone and every tenth on two more. */
async function crowdedEvent(f: PushFixture): Promise<string> {
  const event = await f.newEvent({ phase: "live" });
  await f.owner("UPDATE event SET starts_at = now() - interval '1 hour' WHERE id = $1", [event]);
  const tag = randomUUID().slice(0, 8);
  await f.owner(
    `INSERT INTO player (username) SELECT 'pe_' || $1 || '_' || g FROM generate_series(1, $2) g`,
    [tag, MEMBERS],
  );
  await f.owner(
    `INSERT INTO player_refresh (player_id, family, token_hash, expires_at)
     SELECT p.id, gen_random_uuid(), sha256(convert_to(p.id::text || k, 'UTF8')), now() + interval '180 days'
     FROM player p CROSS JOIN generate_series(1, 3) k
     WHERE p.username LIKE 'pe\\_' || $1 || '%' AND (k = 1 OR right(p.username, 1) = '0')`,
    [tag],
  );
  await f.owner(
    `INSERT INTO push_device (player_id, family, platform, token, environment, language, app_version)
     SELECT r.player_id, r.family, 'ios', md5(r.family::text) || md5(r.player_id::text), 'production', 'ar', '1'
     FROM player_refresh r JOIN player p ON p.id = r.player_id WHERE p.username LIKE 'pe\\_' || $1 || '%'`,
    [tag],
  );
  await f.owner(
    `INSERT INTO enrollment (organizer_id, event_id, player_id)
     SELECT e.organizer_id, e.id, p.id FROM player p CROSS JOIN event e
     WHERE e.id = $1 AND p.username LIKE 'pe\\_' || $2 || '%'`,
    [event, tag],
  );
  return event;
}

/** Runs the fan-out until it is done; reports the total, the calls, the slowest, the first and the median call. */
async function timeFanOut(f: PushFixture, label: string): Promise<void> {
  const calls: number[] = [];
  const started = performance.now();
  for (;;) {
    const one = performance.now();
    const done = await f.one<{ rows: number; more: boolean }>(
      f.system,
      "SELECT push_fan_out() AS r",
    );
    calls.push(performance.now() - one);
    if (!done.more) break;
  }
  const sorted = calls.toSorted((a, b) => a - b);
  say(
    `${label}: ${ms(performance.now() - started)} ms in ${calls.length} calls, slowest ${ms(sorted.at(-1))} ms, ` +
      `first ${ms(calls[0])} ms, median ${ms(sorted[Math.floor(calls.length / 2)])} ms`,
  );
}

/** Seven claim rounds of 200, each acknowledged; reports the median and the worst. */
async function timeClaims(f: PushFixture, label: string): Promise<void> {
  await f.owner("ANALYZE push_send");
  const rounds: number[] = [];
  for (let round = 0; round < 7; round += 1) {
    const one = performance.now();
    const claimed = await f.claim(undefined, 200);
    // Every row of a round may be skipped at the claim (the gated opening): nothing to acknowledge then.
    if (claimed.length > 0) {
      await f.ack(
        claimed.map((row) => ({ id: row.send_id, lease: row.lease, outcome: "sent", attempts: 1 })),
      );
    }
    rounds.push(performance.now() - one);
  }
  const sorted = rounds.toSorted((a, b) => a - b);
  const skipped = await f.count("push_send WHERE state = 'skipped'");
  say(
    `${label} (7 rounds): median ${ms(sorted[3])} ms, worst ${ms(sorted[6])} ms; skipped so far ${skipped}`,
  );
}

/** A live poll sent to every member, fanned out and claimed. */
async function timePoll(f: PushFixture, event: string): Promise<void> {
  const [poll] = await f.owner<{ id: string }>(
    `INSERT INTO quest (event_id, category_id, type, title_en, points, visible, type_config)
     SELECT $1, id, 'vote', 'Pick one', 10, false, $2::jsonb FROM category WHERE event_id = $1 LIMIT 1
     RETURNING id`,
    [event, JSON.stringify(LIVE_POLL)],
  );
  await f.owner("ANALYZE");
  await f.run(f.team(), "SELECT * FROM send_poll($1, $2, $3)", [event, poll?.id, randomUUID()]);
  await timeFanOut(f, `live poll fan-out to ${MEMBERS} members`);
  say(`queued sends: ${await f.count("push_send WHERE state = 'queued'")}`);
  await timeClaims(f, "claim + ack of 200, poll queue");
}

/**
 * A category's opening fanned out to every member, then a 20-quest gate set on the category, which the first CLEARED
 * members have cleared: the claim of its queued pushes and the fan-out of an opening notice of the gated category.
 */
async function timeGatedOpening(f: PushFixture, event: string): Promise<void> {
  const [gate] = await f.owner<{ id: string }>(
    "INSERT INTO category (event_id, name_en) VALUES ($1, 'Gate') RETURNING id",
    [event],
  );
  await f.owner(
    `INSERT INTO quest (event_id, category_id, type, title_en, points, visible)
     SELECT $1, $2, 'scan_qr', 'Gate ' || g, 10, true FROM generate_series(1, $3) g`,
    [event, gate?.id, GATE_QUESTS],
  );
  await f.owner(
    `INSERT INTO quest_completion (organizer_id, event_id, enrollment_id, quest_id, occurrence, method, idempotency_key)
     SELECT n.organizer_id, n.event_id, n.id, q.id, 1, 'qr', gen_random_uuid()::text
     FROM (SELECT * FROM enrollment WHERE event_id = $1 ORDER BY id LIMIT $3) n
     JOIN quest q ON q.category_id = $2`,
    [event, gate?.id, CLEARED],
  );
  const [opening] = await f.owner<{ id: string }>(
    "INSERT INTO category (event_id, name_en, opens_at) VALUES ($1, 'Stage', now() - interval '1 minute') RETURNING id",
    [event],
  );
  await f.owner(
    "INSERT INTO quest (event_id, category_id, type, title_en, points, visible) VALUES ($1, $2, 'scan_qr', 'Stage', 10, true)",
    [event, opening?.id],
  );
  await f.drain();
  await f.owner("ANALYZE");
  await f.notice("category_open", { event, refs: { category: opening?.id } });
  await timeFanOut(f, `category opening fan-out to ${MEMBERS} members`);
  await f.owner("UPDATE category SET unlock_after = $2 WHERE id = $1", [opening?.id, gate?.id]);
  await timeClaims(
    f,
    "claim + ack of 200 after a 20-quest gate was set (members who cleared it first)",
  );
  await f.notice("category_open", { event, refs: { category: opening?.id } });
  await timeFanOut(f, "gated category opening fan-out (no row written)");
}

it.skipIf(OUT === undefined || TEST_DATABASE_URL === undefined)(
  "times the event pushes' fan-out to 50,000 members and the claims behind it",
  async () => {
    const f = await pushFixture();
    try {
      const event = await crowdedEvent(f);
      await timePoll(f, event);
      await timeGatedOpening(f, event);
    } finally {
      await f.close();
    }
  },
  900_000,
);
