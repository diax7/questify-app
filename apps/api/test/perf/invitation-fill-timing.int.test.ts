import { appendFileSync } from "node:fs";
import { it } from "vitest";
import { invitationFixture } from "#test/support/invitations";
import { TEST_DATABASE_URL } from "#test/support/test-db";

/**
 * Times the invitation fill and the console's audience estimate at 100,000 players opted in to promotional SMS (T-409,
 * ADR-333). Not an assertion (a timing check is flaky on a 2-core runner), like the other timing files: run it by hand
 * when the fill or promo_pool changes,
 * `INVITATION_TIMING=/path/to/out.txt pnpm vitest run apps/api/test/perf/invitation-fill-timing.int.test.ts`.
 * Gate (plan): the fill under 2 s (the API's statement limit is 5 s, pool-options.ts).
 */
const OUT = process.env["INVITATION_TIMING"];
const say = (line: string) => appendFileSync(String(OUT), `${line}\n`);
const PLAYERS = 100_000;

it.skipIf(OUT === undefined || TEST_DATABASE_URL === undefined)(
  "times the estimate and the fill over 100,000 opted-in players",
  async () => {
    const f = await invitationFixture();
    try {
      await f.switchOn();
      await f.owner(
        `INSERT INTO player (username, birth_year)
         SELECT 'tf_' || n, 1990 FROM generate_series(1, $1) n`,
        [PLAYERS],
      );
      await f.owner(
        `INSERT INTO player_contact (player_id, phone_e164)
         SELECT id, '+9665' || lpad(row_number() OVER (ORDER BY id)::text, 8, '0')
         FROM player WHERE username LIKE 'tf\\_%'`,
      );
      await f.owner(
        `INSERT INTO marketing_consent (player_id, channel, granted, method, text_version)
         SELECT id, 'sms', true, 'settings', '1' FROM player WHERE username LIKE 'tf\\_%'`,
      );
      await f.owner("ANALYZE");
      const event = await f.eligibleEvent();
      const made = await f.request(event, { size: PLAYERS });
      let started = performance.now();
      const [detail] = await f.run<{ r: { estimate: number } }>(
        f.adminSeat,
        "SELECT invitation_admin_get($1) AS r",
        [made.id],
      );
      say(`estimate ${detail?.r.estimate} players: ${Math.round(performance.now() - started)} ms`);
      await f.approve(made.id, { cap: PLAYERS });
      started = performance.now();
      const outcome = await f.startDue();
      say(`fill (${outcome}, ${PLAYERS} rows): ${Math.round(performance.now() - started)} ms`);
      started = performance.now();
      await f.claimAt(5);
      say(`first claim of 5: ${Math.round(performance.now() - started)} ms`);
      started = performance.now();
      await f.settle();
      say(`settle: ${Math.round(performance.now() - started)} ms`);
    } finally {
      await f.close();
    }
  },
  600_000,
);
