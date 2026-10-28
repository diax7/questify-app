import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { it } from "vitest";
import { pushFixture } from "#test/support/push";
import { TEST_DATABASE_URL } from "#test/support/test-db";

/**
 * Times the fan-out of the heaviest event push at the plan's size (T-501e, ADR-354 (5)): a live poll sent to 50,000
 * active members with 1.2 devices each (60,000 sends), where every member is checked for the quest it names
 * (`member_sees_quest`), for being allowed to play and for not having voted. Not an assertion (a timing check is flaky
 * on a 2-core runner), like the other timing files: run it by hand when the event pushes' audience rules change,
 * `PUSH_TIMING=/path/to/out.txt pnpm vitest run apps/api/test/perf/push-event-timing.int.test.ts`.
 * Gates (T-501 plan): each fan-out call under 1 s and the whole under 30 s on the laptop; claim plus ack of 200 under
 * 200 ms with that queue present (the claim checks each row again).
 */
const OUT = process.env["PUSH_TIMING"];
const say = (line: string) => appendFileSync(String(OUT), `${line}\n`);
const MEMBERS = 50_000;

it.skipIf(OUT === undefined || TEST_DATABASE_URL === undefined)(
  "times a live poll's fan-out to 50,000 members and the claim behind it",
  async () => {
    const f = await pushFixture();
    try {
      const event = await f.newEvent({ phase: "live" });
      const tag = randomUUID().slice(0, 8);
      await f.owner(
        `INSERT INTO player (username) SELECT 'pe_' || $1 || '_' || g FROM generate_series(1, $2) g`,
        [tag, MEMBERS],
      );
      // 1.2 devices each: every player one sign-in, every tenth two more.
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
      const [poll] = await f.owner<{ id: string }>(
        `INSERT INTO quest (event_id, category_id, type, title_en, points, visible, type_config)
         SELECT $1, id, 'vote', 'Pick one', 10, false, $2::jsonb FROM category WHERE event_id = $1 LIMIT 1
         RETURNING id`,
        [
          event,
          JSON.stringify({
            options: [
              { id: "a", text: { en: "Robots" } },
              { id: "b", text: { en: "Space" } },
            ],
            live: { choices: "one", results: "after_vote", minutes: 30 },
          }),
        ],
      );
      await f.owner("ANALYZE");
      await f.run(f.team(), "SELECT * FROM send_poll($1, $2, $3)", [event, poll?.id, randomUUID()]);
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
      say(
        `live poll fan-out to ${MEMBERS} members: ${Math.round(performance.now() - started)} ms in ${calls.length} ` +
          `calls, slowest ${Math.round(Math.max(...calls))} ms, first ${Math.round(calls[0] ?? 0)} ms, median ` +
          `${Math.round(calls.toSorted((a, b) => a - b)[Math.floor(calls.length / 2)] ?? 0)} ms`,
      );
      say(
        `center rows: ${await f.count("notification")}, queued sends: ${await f.count("push_send WHERE state = 'queued'")}`,
      );
      // The claim checks every picked row again (the quest seen, not voted, may play): its gate stays 200 ms for 200.
      await f.owner("ANALYZE push_send");
      const rounds: number[] = [];
      for (let round = 0; round < 7; round += 1) {
        const one = performance.now();
        const claimed = await f.claim(undefined, 200);
        await f.ack(
          claimed.map((row) => ({
            id: row.send_id,
            lease: row.lease,
            outcome: "sent",
            attempts: 1,
          })),
        );
        rounds.push(performance.now() - one);
      }
      const sorted = rounds.toSorted((a, b) => a - b);
      say(
        `claim + ack of 200 (7 rounds): median ${Math.round(sorted[3] ?? 0)} ms, worst ${Math.round(sorted[6] ?? 0)} ms`,
      );
    } finally {
      await f.close();
    }
  },
  600_000,
);
