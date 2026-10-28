import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { it } from "vitest";
import { pushFixture } from "#test/support/push";
import { TEST_DATABASE_URL } from "#test/support/test-db";

/**
 * Times the push fan-out and the claim at the plan's size (T-501, ADR-345 (7)): one event notice to 50,000 active
 * members with 1.2 devices each (60,000 sends), then claim plus ack of 200 with that queue present. Not an
 * assertion (a timing check is flaky on a 2-core runner), like the other timing files: run it by hand when the fan-out,
 * the claim or their indexes change,
 * `PUSH_TIMING=/path/to/out.txt pnpm vitest run apps/api/test/perf/push-timing.int.test.ts`.
 * Gates (plan): each fan-out call under 1 s and the whole under 30 s; claim plus ack of 200 under 200 ms, also with
 * 65,000 event rows or 10,000 personal notices queued (at most 200 heads visited, code review MAJOR); a 50,000-row
 * notice then a 10-row one, the first claim takes 100 and 10. The default suite keeps cheap versions of the last two
 * (`test/db/push-sending.int`).
 */
const OUT = process.env["PUSH_TIMING"];
const say = (line: string) => appendFileSync(String(OUT), `${line}\n`);
const MEMBERS = 50_000;

it.skipIf(OUT === undefined || TEST_DATABASE_URL === undefined)(
  "times the fan-out to 50,000 members and the claim with 65,000 rows queued",
  async () => {
    const f = await pushFixture();
    try {
      const event = await f.newEvent({ phase: "live" });
      const tag = randomUUID().slice(0, 8);
      await f.owner(
        `INSERT INTO player (username) SELECT 'pt_' || $1 || '_' || g FROM generate_series(1, $2) g`,
        [tag, MEMBERS],
      );
      // 1.2 devices each: every player one sign-in, every tenth two more.
      await f.owner(
        `INSERT INTO player_refresh (player_id, family, token_hash, expires_at)
         SELECT p.id, gen_random_uuid(), sha256(convert_to(p.id::text || k, 'UTF8')), now() + interval '180 days'
         FROM player p CROSS JOIN generate_series(1, 3) k
         WHERE p.username LIKE 'pt\\_' || $1 || '%' AND (k = 1 OR right(p.username, 1) = '0')`,
        [tag],
      );
      await f.owner(
        `INSERT INTO push_device (player_id, family, platform, token, environment, language, app_version)
         SELECT r.player_id, r.family, 'ios', md5(r.family::text) || md5(r.player_id::text), 'production', 'ar', '1'
         FROM player_refresh r JOIN player p ON p.id = r.player_id WHERE p.username LIKE 'pt\\_' || $1 || '%'`,
        [tag],
      );
      await f.owner(
        `INSERT INTO enrollment (organizer_id, event_id, player_id)
         SELECT e.organizer_id, e.id, p.id FROM player p CROSS JOIN event e
         WHERE e.id = $1 AND p.username LIKE 'pt\\_' || $2 || '%'`,
        [event, tag],
      );
      await f.owner("ANALYZE");
      const kind = await f.kind({ class: "event", topic: "announcements" });
      await f.notice(kind, { event });
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
        `fan-out of ${MEMBERS} members: ${Math.round(performance.now() - started)} ms in ${calls.length} calls, ` +
          `slowest ${Math.round(Math.max(...calls))} ms`,
      );
      say(`queued sends: ${await f.count("push_send WHERE state = 'queued'")}`);
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

/** Claim plus ack of 200 over `rounds` rounds; answers the median and the worst, in ms. */
async function timeClaims(f: Awaited<ReturnType<typeof pushFixture>>, rounds: number) {
  const times: number[] = [];
  for (let round = 0; round < rounds; round += 1) {
    const one = performance.now();
    const claimed = await f.claim(undefined, 200);
    await f.ack(
      claimed.map((row) => ({ id: row.send_id, lease: row.lease, outcome: "sent", attempts: 1 })),
    );
    times.push(performance.now() - one);
  }
  const sorted = times.toSorted((a, b) => a - b);
  return `median ${Math.round(sorted[Math.floor(rounds / 2)] ?? 0)} ms, worst ${Math.round(sorted.at(-1) ?? 0)} ms`;
}

it.skipIf(OUT === undefined || TEST_DATABASE_URL === undefined)(
  "times the claim with 65,000 event rows queued, with 10,000 personal notices queued, and the 50,000-row fairness",
  async () => {
    const f = await pushFixture();
    try {
      const phone = await f.playerWithPhone();
      const queued = await f.kind({ class: "event" });
      for (let i = 0; i < 13; i += 1) await f.syntheticQueue(queued, 5000, phone.deviceId);
      const personal = await f.kind();
      await f.personalQueue(personal, 1000);
      await f.owner("ANALYZE push_send");
      say(`claim + ack of 200 with 65,000 event rows queued: ${await timeClaims(f, 5)}`);
      await f.drain();
      await f.personalQueue(personal, 10_000);
      await f.owner("ANALYZE push_send");
      const [heads] = await f.owner<{ n: number }>(
        "SELECT count(*)::int AS n FROM push_queue_heads('{apns:production,apns:sandbox,fcm}')",
      );
      say(`heads with 10,000 personal notices queued: ${heads?.n} (at most 200)`);
      say(`claim + ack of 200 with 10,000 personal notices queued: ${await timeClaims(f, 5)}`);
      await f.drain();
      const big = await f.syntheticQueue(queued, 50_000, phone.deviceId);
      const small = await f.syntheticQueue(queued, 10, phone.deviceId);
      await f.claim(["apns:production"], 200);
      const picked = await f.owner<{ notice_id: string; n: number }>(
        `SELECT notice_id, count(*)::int AS n FROM push_send
         WHERE notice_id = ANY ($1) AND state <> 'queued' GROUP BY 1 ORDER BY 1`,
        [[big, small]],
      );
      say(
        `a 50,000-row notice then a 10-row notice, first claim takes: ${JSON.stringify(picked.map((row) => row.n))}`,
      );
    } finally {
      await f.close();
    }
  },
  600_000,
);
