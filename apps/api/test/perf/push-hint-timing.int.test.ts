import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { it } from "vitest";
import { pushFixture, type PushFixture } from "#test/support/push";
import { TEST_DATABASE_URL } from "#test/support/test-db";

/**
 * Times the hidden-category hint at the plan's size (T-501g, ADR-357): 50,000 active members with a phone each. The
 * count behind the confirmation dialog (category_hint_preview, one set-based statement, with and without an audience
 * rule on the category), the press, and the fan-out that reveals the category and writes the center rows. Not an
 * assertion (a timing check is flaky on a 2-core runner), like the other timing files: run it by hand when the hint's
 * rules or the fan-out change,
 * `PUSH_TIMING=/path/to/out.txt pnpm vitest run apps/api/test/perf/push-hint-timing.int.test.ts`.
 * Hard gates: the count and each fan-out call inside the API's 5 s statement limit, each fan-out call under 1 s.
 */
const OUT = process.env["PUSH_TIMING"];
const say = (line: string) => appendFileSync(String(OUT), `${line}\n`);
const MEMBERS = 50_000;
const ms = (value: number | undefined) => Math.round(value ?? 0);

/** A live event with MEMBERS members, each with an iOS phone, and a hidden category holding one quest. */
async function crowdedEvent(f: PushFixture): Promise<{ event: string; category: string }> {
  const event = await f.newEvent({ phase: "live" });
  const tag = randomUUID().slice(0, 8);
  await f.owner(
    `INSERT INTO player (username) SELECT 'ph_' || $1 || '_' || g FROM generate_series(1, $2) g`,
    [tag, MEMBERS],
  );
  await f.owner(
    `INSERT INTO player_contact (player_id, email)
     SELECT p.id, p.username || '@perf.test' FROM player p WHERE p.username LIKE 'ph\\_' || $1 || '%'`,
    [tag],
  );
  await f.owner(
    `INSERT INTO player_refresh (player_id, family, token_hash, expires_at)
     SELECT p.id, gen_random_uuid(), sha256(convert_to(p.id::text, 'UTF8')), now() + interval '180 days'
     FROM player p WHERE p.username LIKE 'ph\\_' || $1 || '%'`,
    [tag],
  );
  await f.owner(
    `INSERT INTO push_device (player_id, family, platform, token, environment, language, app_version)
     SELECT r.player_id, r.family, 'ios', md5(r.family::text) || md5(r.player_id::text), 'production', 'ar', '1'
     FROM player_refresh r JOIN player p ON p.id = r.player_id WHERE p.username LIKE 'ph\\_' || $1 || '%'`,
    [tag],
  );
  await f.owner(
    `INSERT INTO enrollment (organizer_id, event_id, player_id, joined_at)
     SELECT e.organizer_id, e.id, p.id, now() - interval '1 hour' FROM player p CROSS JOIN event e
     WHERE e.id = $1 AND p.username LIKE 'ph\\_' || $2 || '%'`,
    [event, tag],
  );
  const [made] = await f.owner<{ id: string }>(
    "INSERT INTO category (event_id, name_en, hidden) VALUES ($1, 'Secret garden', true) RETURNING id",
    [event],
  );
  await f.owner(
    "INSERT INTO quest (event_id, category_id, type, title_en, points, visible) VALUES ($1, $2, 'scan_qr', 'Rose', 10, true)",
    [event, made?.id],
  );
  await f.owner("ANALYZE");
  return { event, category: made?.id ?? "" };
}

async function timed<T>(work: () => Promise<T>): Promise<[T, number]> {
  const started = performance.now();
  const value = await work();
  return [value, performance.now() - started];
}

it.skipIf(OUT === undefined || TEST_DATABASE_URL === undefined)(
  "times the hint's count, press and fan-out for 50,000 members",
  async () => {
    const f = await pushFixture();
    try {
      const { event, category } = await crowdedEvent(f);
      const preview = () =>
        f.run<{ members: number }>(f.team(), "SELECT * FROM category_hint_preview($1, $2)", [
          event,
          category,
        ]);
      const plan = await f.owner<Record<string, string>>(
        `EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
         SELECT count(*) FROM enrollment n JOIN player p ON p.id = n.player_id AND p.status = 'active'
         WHERE n.event_id = $1 AND n.status = 'active'
           AND (n.joined_via IS NOT DISTINCT FROM 'rehearsal') = false
           AND NOT excluded_from_event(n.event_id, n.player_id)
           AND NOT EXISTS (SELECT 1 FROM staff_assignment sa
                           WHERE sa.event_id = n.event_id AND sa.player_id = n.player_id AND NOT sa.can_play)
           AND NOT EXISTS (SELECT 1 FROM notice earlier JOIN notification told ON told.notice_id = earlier.id
                           WHERE earlier.event_id = n.event_id AND earlier.kind = 'category_hint'
                             AND earlier.audience = 'event' AND earlier.refs ->> 'category' = $2::text
                             AND told.player_id = n.player_id AND told.created_at >= n.joined_at)`,
        [event, category],
      );
      say(plan.map((row) => row["QUERY PLAN"]).join("\n"));
      const [counted, countMs] = await timed(preview);
      say(`count of ${counted[0]?.members} members, no audience rule: ${ms(countMs)} ms`);

      // An audience rule on the category: the tag rule joins each member's contact to the guest list.
      await f.owner(
        `INSERT INTO event_guest (organizer_id, event_id, kind, value, tag)
         SELECT e.organizer_id, e.id, 'email', p.username || '@perf.test', 'vip'
         FROM event e JOIN LATERAL (SELECT n.player_id FROM enrollment n WHERE n.event_id = e.id LIMIT 10000) n ON true
         JOIN player p ON p.id = n.player_id WHERE e.id = $1`,
        [event],
      );
      await f.owner(
        "UPDATE category SET audience_kind = 'tag', audience_values = '{vip}' WHERE id = $1",
        [category],
      );
      await f.owner("ANALYZE");
      const [targeted, targetedMs] = await timed(preview);
      say(`count of ${targeted[0]?.members} members, a tag audience rule: ${ms(targetedMs)} ms`);
      await f.owner(
        "UPDATE category SET audience_kind = NULL, audience_values = NULL WHERE id = $1",
        [category],
      );

      await f.drain();
      const [pressed, pressMs] = await timed(() =>
        f.run(f.team(), "SELECT * FROM send_category_hint($1, $2, $3, $4)", [
          event,
          category,
          randomUUID(),
          randomUUID(),
        ]),
      );
      say(
        `press: ${ms(pressMs)} ms, ${JSON.stringify(pressed)}, notices ${await f.count("notice WHERE kind = $1", ["category_hint"])}`,
      );
      const calls: number[] = [];
      const started = performance.now();
      for (;;) {
        const [done, took] = await timed(() =>
          f.one<{ rows: number; more: boolean }>(f.system, "SELECT push_fan_out() AS r"),
        );
        calls.push(took);
        if (!done.more) break;
      }
      const sorted = calls.toSorted((a, b) => a - b);
      say(
        `fan-out to ${MEMBERS} members: ${ms(performance.now() - started)} ms in ${calls.length} calls, ` +
          `slowest ${ms(sorted.at(-1))} ms, median ${ms(sorted[Math.floor(calls.length / 2)])} ms`,
      );
      say(`reveals: ${await f.count("category_reveal WHERE category_id = $1", [category])}`);
      const [after, afterMs] = await timed(preview);
      say(`count after the hint (everyone told): ${after[0]?.members} members, ${ms(afterMs)} ms`);
    } finally {
      await f.close();
    }
  },
  900_000,
);
