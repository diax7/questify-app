import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RequestContext } from "#src/db/context";
import { pushFixture, sqlstate, type PushFixture } from "#test/support/push";
import { TEST_DATABASE_URL } from "#test/support/test-db";

type Queue = Readonly<{
  targets: readonly Readonly<{
    targetId: string;
    urgent: boolean;
    dueAt: string;
    overdue: boolean;
  }>[];
  urgentTotal: number;
}>;

/**
 * Urgent reports in the database (T-701b, migration 0130, ADR-493, ADR-494): urgency and due time fixed at arrival,
 * the queue's order, and one team alert per target per open episode; the alert outbox's claim and answer; the
 * moderation addresses door.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("urgent reports (database)", () => {
  let f: PushFixture;
  let admin: RequestContext = {};
  beforeAll(async () => {
    f = await pushFixture();
    const [made] = await f.owner<{ id: string }>(
      "INSERT INTO staff_user (email, password_hash, platform_role) VALUES ('urgent@questify.test', 'h', 'admin') RETURNING id",
    );
    admin = { isAdmin: true, staffUserId: made?.id ?? "" };
  });
  afterAll(async () => {
    await f.close();
  });

  const reportEvent = async (event: string, reason = "offensive") => {
    const player = await f.newPlayer();
    await f.join(event, player);
    return f.one<string>(
      { playerId: player },
      "SELECT report_content('event', $1, NULL, NULL, $2, NULL) AS r",
      [event, reason],
    );
  };
  const rowsOf = (event: string) =>
    f.owner<{ urgent: boolean; hours: number }>(
      `SELECT urgent, round(extract(epoch FROM due_at - created_at) / 3600)::int AS hours
       FROM content_report WHERE target_id = $1`,
      [event],
    );
  const alertsOf = (event: string) => f.count("team_alert WHERE target_id = $1", [event]);
  const resolve = (event: string) =>
    f.one<number>(admin, "SELECT admin_report_resolve('event', $1, 'dismissed', $2) AS r", [
      event,
      randomUUID(),
    ]);

  it("makes a report on a live event urgent and due in an hour, every other one due in a day", async () => {
    const live = await f.newEvent({ phase: "live" });
    await reportEvent(live);
    expect(await rowsOf(live)).toEqual([{ urgent: true, hours: 1 }]);
    for (const phase of ["scheduled", "ended"] as const) {
      const event = await f.newEvent({ phase });
      if (phase === "ended") {
        await f.owner("UPDATE event SET status = 'ended' WHERE id = $1", [event]);
      }
      await reportEvent(event);
      expect(await rowsOf(event)).toEqual([{ urgent: false, hours: 24 }]);
    }
  });

  it("ignores the urgency and due time a writer passes", async () => {
    const event = await f.newEvent({ phase: "scheduled" });
    await f.owner(
      `INSERT INTO content_report (event_id, target_kind, target_id, snapshot, reason, urgent, due_at)
       VALUES ($1, 'event', $1, '{}', 'spam', true, now())`,
      [event],
    );
    expect(await rowsOf(event)).toEqual([{ urgent: false, hours: 24 }]);
    expect(await alertsOf(event)).toBe(0);
  });

  it("queues one alert per open episode, none for a normal report, a new one after resolution", async () => {
    const live = await f.newEvent({ phase: "live" });
    await reportEvent(live);
    await reportEvent(live);
    expect(await alertsOf(live)).toBe(1);
    expect(await resolve(live)).toBe(2);
    await reportEvent(live);
    expect(await alertsOf(live)).toBe(2);
    const normal = await f.newEvent({ phase: "scheduled" });
    await reportEvent(normal);
    expect(await alertsOf(normal)).toBe(0);
  });

  it("deletes a username alert with the username report an erasure deletes", async () => {
    const live = await f.newEvent({ phase: "live" });
    const [reporter, reported] = [await f.newPlayer(), await f.newPlayer()];
    await f.join(live, reporter);
    await f.join(live, reported);
    const [named] = await f.owner<{ username: string }>(
      "SELECT username FROM player WHERE id = $1",
      [reported],
    );
    await f.one<string>(
      { playerId: reporter },
      "SELECT report_content('username', NULL, $1, $2, 'offensive', NULL) AS r",
      [named?.username, live],
    );
    expect(await alertsOf(reported)).toBe(1);
    await f.owner("DELETE FROM content_report WHERE target_kind = 'username' AND target_id = $1", [
      reported,
    ]);
    expect(await alertsOf(reported)).toBe(0);
  });

  it("makes one alert of two urgent reports arriving together", async () => {
    const live = await f.newEvent({ phase: "live" });
    const players = [await f.newPlayer(), await f.newPlayer()];
    for (const player of players) await f.join(live, player);
    await Promise.all(
      players.map((player) =>
        f.run(
          { playerId: player },
          "SELECT report_content('event', $1, NULL, NULL, 'spam', NULL)",
          [live],
        ),
      ),
    );
    expect(await alertsOf(live)).toBe(1);
  });

  it("puts urgent targets first, then the earliest due, with the urgent count", async () => {
    const normal = await f.newEvent({ phase: "scheduled" });
    await reportEvent(normal);
    const live = await f.newEvent({ phase: "live" });
    await reportEvent(live);
    await f.owner(
      "UPDATE content_report SET due_at = now() - interval '5 minutes' WHERE target_id = $1",
      [live],
    );
    const queue = await f.one<Queue>(admin, "SELECT console_reports(NULL, $1) AS r", [
      randomUUID(),
    ]);
    const ids = queue.targets.map((target) => target.targetId);
    expect(ids.indexOf(live)).toBeLessThan(ids.indexOf(normal));
    expect(queue.targets.find((target) => target.targetId === live)).toMatchObject({
      urgent: true,
      overdue: true,
    });
    expect(queue.urgentTotal).toBeGreaterThanOrEqual(1);
    const counts = await f.one<{ open: number; urgent: number }>(
      admin,
      "SELECT console_report_counts() AS r",
    );
    expect(counts.urgent).toBe(queue.urgentTotal);
    expect(await sqlstate(f.run(f.team(), "SELECT console_report_counts()"))).toBe("QE403");
    const urgentFlags = queue.targets.map((target) => target.urgent);
    expect(urgentFlags).toEqual(urgentFlags.toSorted((a, b) => Number(b) - Number(a)));
  });

  it("claims, answers and retries the outbox: a refused send twice more, never a sent or uncertain one", async () => {
    await f.owner(
      "UPDATE team_alert SET state = 'sent', finished_at = now() WHERE state = 'queued'",
    );
    const live = await f.newEvent({ phase: "live" });
    await reportEvent(live, "hateful");
    const claim = async () =>
      f.run<{ id: string; doc: { targetId: string; reports: number; reasons: string[] } }>(
        {},
        "SELECT * FROM team_alert_claim($1, 50)",
        [randomUUID()],
      );
    const ack = async (lease: string, ids: string[], outcome: string) =>
      f.one<number>({}, "SELECT team_alert_ack($1::bigint[], $2, $3) AS r", [ids, lease, outcome]);
    for (const round of [1, 2, 3]) {
      const lease = randomUUID();
      const rows = await f.run<{ id: string; doc: { targetId: string; reasons: string[] } }>(
        {},
        "SELECT * FROM team_alert_claim($1, 50)",
        [lease],
      );
      expect(
        rows.map((row) => row.doc.targetId),
        `round ${round}`,
      ).toEqual([live]);
      expect(rows[0]?.doc.reasons).toEqual(["hateful"]);
      expect(
        await ack(
          lease,
          rows.map((row) => row.id),
          "failed",
        ),
      ).toBe(1);
    }
    expect(await claim()).toEqual([]);
    expect(
      (
        await f.owner<{ state: string }>("SELECT state FROM team_alert WHERE target_id = $1", [
          live,
        ])
      )[0]?.state,
    ).toBe("failed");
    const other = await f.newEvent({ phase: "live" });
    await reportEvent(other);
    await resolve(other);
    expect(await claim()).toEqual([]);
    expect(
      (
        await f.owner<{ state: string }>("SELECT state FROM team_alert WHERE target_id = $1", [
          other,
        ])
      )[0]?.state,
    ).toBe("skipped");
  });

  it("turns a lease that ran out into uncertain, never sent again", async () => {
    await f.owner(
      "UPDATE team_alert SET state = 'sent', finished_at = now() WHERE state = 'queued'",
    );
    const live = await f.newEvent({ phase: "live" });
    await reportEvent(live);
    const lease = randomUUID();
    await f.run({}, "SELECT * FROM team_alert_claim($1, 50)", [lease]);
    await f.owner(
      "UPDATE team_alert SET lease_until = now() - interval '1 second' WHERE lease = $1",
      [lease],
    );
    expect(await f.run({}, "SELECT * FROM team_alert_claim($1, 50)", [randomUUID()])).toEqual([]);
    expect(
      (
        await f.owner<{ state: string }>("SELECT state FROM team_alert WHERE target_id = $1", [
          live,
        ])
      )[0]?.state,
    ).toBe("uncertain");
  });

  const set = (alert: string | null, appeal: string | null, seat = admin) =>
    f.one<Record<string, string>>(seat, "SELECT admin_set_moderation_addresses($1, $2, $3) AS r", [
      alert,
      appeal,
      randomUUID(),
    ]);

  describe("moderation addresses", () => {
    it("is refused to anyone but an admin and to a value that is not an address", async () => {
      for (const seat of [{}, f.team(), { isAdmin: true }] satisfies RequestContext[]) {
        expect(await sqlstate(set("a@b.co", null, seat))).toBe("QE403");
      }
      expect(await sqlstate(set("nope", null))).toBe("MA422");
    });

    it("sets, clears and keeps other keys, audited before and after", async () => {
      await f.owner(
        `INSERT INTO platform_setting (key, value) VALUES ('moderation', '{"other": 1}')
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      );
      expect(await set(" Alerts@Questify.test ", "appeals@questify.test")).toEqual({
        other: 1,
        alertEmail: "alerts@questify.test",
        appealEmail: "appeals@questify.test",
      });
      expect(await set(null, "appeals@questify.test")).toEqual({
        other: 1,
        appealEmail: "appeals@questify.test",
      });
      const [audit] = await f.owner<{ before: object; after: object }>(
        "SELECT before, after FROM audit_log WHERE action = 'platform_settings.update' AND target_id = 'moderation' ORDER BY id DESC LIMIT 1",
      );
      expect(audit?.after).toEqual({ other: 1, appealEmail: "appeals@questify.test" });
      expect(audit?.before).toMatchObject({ alertEmail: "alerts@questify.test" });
    });
  });
});
