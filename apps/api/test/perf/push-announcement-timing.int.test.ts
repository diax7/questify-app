import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { pushFixture, type PushFixture } from "#test/support/push";
import { TEST_DATABASE_URL } from "#test/support/test-db";

const OUT = process.env["PUSH_TIMING"];
const MEMBERS = 50_000;
const say = (line: string) => appendFileSync(String(OUT), line + "\n");

async function seedCrowd(fixture: PushFixture): Promise<string> {
  const event = await fixture.newEvent({ phase: "live" });
  const tag = "pa_" + randomUUID().slice(0, 8) + "_";
  await fixture.owner(
    "INSERT INTO player (username) SELECT $1 || g FROM generate_series(1, $2) g",
    [tag, MEMBERS],
  );
  await fixture.owner(
    "INSERT INTO player_contact (player_id, email) SELECT id, username || '@perf.test' FROM player WHERE left(username, length($1)) = $1",
    [tag],
  );
  await fixture.owner(
    "INSERT INTO player_refresh (player_id, family, token_hash, expires_at) SELECT id, gen_random_uuid(), sha256(convert_to(id::text, 'UTF8')), now() + interval '180 days' FROM player WHERE left(username, length($1)) = $1",
    [tag],
  );
  await fixture.owner(
    "INSERT INTO push_device (player_id, family, platform, token, environment, language, app_version) SELECT r.player_id, r.family, 'ios', md5(r.family::text) || md5(r.player_id::text), 'production', 'ar', '1' FROM player_refresh r JOIN player p ON p.id = r.player_id WHERE left(p.username, length($1)) = $1",
    [tag],
  );
  await fixture.owner(
    "INSERT INTO enrollment (organizer_id, event_id, player_id, joined_at) SELECT e.organizer_id, e.id, p.id, now() - interval '1 hour' FROM event e CROSS JOIN player p WHERE e.id = $1 AND left(p.username, length($2)) = $2",
    [event, tag],
  );
  await fixture.owner(
    "INSERT INTO event_exclusion (organizer_id, event_id, kind, value) SELECT organizer_id, id, 'email_domain', 'nobody.test' FROM event WHERE id = $1",
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
  "times announcement count, press and fan-out to 50,000 members",
  async () => {
    const fixture = await pushFixture();
    try {
      const event = await seedCrowd(fixture);
      const [preview, countMs] = await timed(() =>
        fixture.run<{ members: number }>(fixture.team(), "SELECT * FROM announcement_preview($1)", [
          event,
        ]),
      );
      expect(preview[0]?.members).toBe(MEMBERS);
      const draft = {
        titleAr: "الغداء",
        titleEn: "Lunch",
        bodyAr: "القاعة",
        bodyEn: "Hall",
        pushBodyAr: "القاعة",
        pushBodyEn: "Hall",
      };
      const [sent, pressMs] = await timed(() =>
        fixture.run<{ id: string }>(
          fixture.team(),
          "SELECT * FROM announcement_send($1, $2::jsonb, NULL, $3, $4)",
          [event, JSON.stringify(draft), randomUUID(), randomUUID()],
        ),
      );
      expect(sent[0]?.id).toBeDefined();
      const calls: number[] = [];
      const started = performance.now();
      for (;;) {
        const [done, took] = await timed(() =>
          fixture.one<{ more: boolean }>(fixture.system, "SELECT push_fan_out() AS r"),
        );
        calls.push(took);
        if (!done.more) break;
      }
      const slowest = Math.max(...calls);
      say(
        "announcement " +
          MEMBERS +
          " members, count " +
          Math.round(countMs) +
          " ms, press " +
          Math.round(pressMs) +
          " ms",
      );
      say(
        "fan-out " +
          Math.round(performance.now() - started) +
          " ms, " +
          calls.length +
          " calls, slowest " +
          Math.round(slowest) +
          " ms",
      );
      say(
        "1 s call gate: " +
          (Math.max(countMs, pressMs, slowest) < 1000 ? "PASS" : "FAIL") +
          "; 5 s statement gate: " +
          (Math.max(countMs, pressMs, slowest) < 5000 ? "PASS" : "FAIL"),
      );
      expect(await fixture.count("notification WHERE event_id = $1", [event])).toBe(MEMBERS);
    } finally {
      await fixture.close();
    }
  },
  900_000,
);
