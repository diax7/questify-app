import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAuthKeys } from "#src/auth/keys";
import { createVerifyGate } from "#src/auth/verify-gate";
import { startTeamAlertWorker, TEAM_ALERT_BUDGET } from "#src/team-alerts/worker";
import { RecordingEmailSender } from "#test/support/auth-app";
import { pushFixture, type PushFixture } from "#test/support/push";
import { TEST_DATABASE_URL } from "#test/support/test-db";

const MAIL_FROM = "team@questify.test";

/**
 * The team alert worker (T-701b, ADR-494, plan review MAJOR 2): one digest of the queued urgent-report alerts to the
 * moderation address or MAIL_FROM, at most one per 10 minutes and 100 a day on its own budget (never the sign-in
 * `outboundMailPerDay`); a refused send is retried, a late one is `uncertain`; the mail holds no personal data.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("team alert worker", () => {
  let f: PushFixture;
  const mail = new RecordingEmailSender();
  const worker = () =>
    startTeamAlertWorker({
      pool: f.pool,
      keys: createAuthKeys("x".repeat(40)),
      email: mail,
      gate: createVerifyGate({ limit: 1, waitMs: 100 }),
      dashboardOrigin: "https://app.questify.test",
      mailFrom: MAIL_FROM,
      intervalMs: 3_600_000,
      log: () => undefined,
    });
  beforeAll(async () => {
    f = await pushFixture();
  }, 180_000);
  afterAll(async () => {
    await f.close();
  });
  beforeEach(async () => {
    mail.sent.length = 0;
    mail.failing = false;
    await f.owner("DELETE FROM auth_throttle WHERE bucket IN ('team_alert_mail', 'outbound_mail')");
    await f.owner(
      "UPDATE team_alert SET state = 'sent', finished_at = now() WHERE finished_at IS NULL",
    );
  });

  const urgentReport = async (note = "the organizer's DM handle is @secret") => {
    const event = await f.newEvent({ phase: "live" });
    const player = await f.newPlayer();
    await f.join(event, player);
    await f.run(
      { playerId: player },
      "SELECT report_content('event', $1, NULL, NULL, 'hateful', $2)",
      [event, note],
    );
    return { event, player };
  };
  const run = async () => {
    const one = worker();
    try {
      return await one.runOnce();
    } finally {
      await one.stop();
    }
  };

  it("sends one digest of several alerts to MAIL_FROM, with no reporter, note or username", async () => {
    const first = await urgentReport();
    await urgentReport();
    expect(await run()).toMatchObject({ digest: "sent", lines: 2 });
    expect(mail.sent).toHaveLength(1);
    const [digest] = mail.sent;
    expect(digest?.to).toBe(MAIL_FROM);
    expect(digest?.text).toContain(`/en/console/reports/event/${first.event}`);
    expect(digest?.text).not.toContain("@secret");
    const [name] = await f.owner<{ username: string }>(
      "SELECT username FROM player WHERE id = $1",
      [first.player],
    );
    expect(digest?.text).not.toContain(name?.username ?? "no username");
  });

  it("sends nothing more within 10 minutes, and uses the configured alert address", async () => {
    await urgentReport();
    expect((await run()).digest).toBe("sent");
    await urgentReport();
    expect((await run()).digest).toBe("wait");
    await f.owner(
      `INSERT INTO platform_setting (key, value) VALUES ('moderation', '{"alertEmail": "alerts@questify.test"}')
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    );
    await f.owner(
      "UPDATE auth_throttle SET at = at - interval '11 minutes' WHERE bucket = 'team_alert_mail'",
    );
    expect((await run()).digest).toBe("sent");
    expect(mail.sent.at(-1)?.to).toBe("alerts@questify.test");
    await f.owner("DELETE FROM platform_setting WHERE key = 'moderation'");
  });

  it("past 100 digests a day closes the alerts skipped and never touches the sign-in mail budget", async () => {
    await f.owner(
      `INSERT INTO auth_throttle (bucket, key, at)
       SELECT 'team_alert_mail', sha256('questify.team_alert_mail'), now() - interval '1 hour'
       FROM generate_series(1, $1)`,
      [TEAM_ALERT_BUDGET.perDay],
    );
    const { event } = await urgentReport();
    expect((await run()).digest).toBe("capped");
    expect(mail.sent).toHaveLength(0);
    const [row] = await f.owner<{ state: string }>(
      "SELECT state FROM team_alert WHERE target_id = $1",
      [event],
    );
    expect(row?.state).toBe("skipped");
    expect(await f.count("auth_throttle WHERE bucket = 'outbound_mail'")).toBe(0);
  });

  it("retries a refused send at the next digest", async () => {
    const { event } = await urgentReport();
    mail.failing = true;
    expect((await run()).digest).toBe("failed");
    mail.failing = false;
    await f.owner(
      "UPDATE auth_throttle SET at = at - interval '11 minutes' WHERE bucket = 'team_alert_mail'",
    );
    expect((await run()).digest).toBe("sent");
    const [row] = await f.owner<{ state: string; attempts: number }>(
      "SELECT state, attempts FROM team_alert WHERE target_id = $1",
      [event],
    );
    expect(row).toEqual({ state: "sent", attempts: 2 });
  });

  it("applies a held owner email change whose day passed and mails both addresses", async () => {
    const [org] = await f.owner<{ id: string }>(
      "INSERT INTO organizer (name, slug) VALUES ('Held Org', $1) RETURNING id",
      [`held-${randomUUID().slice(0, 8)}`],
    );
    const [account] = await f.owner<{ id: string }>(
      "INSERT INTO staff_user (email, password_hash) VALUES ('held.owner@najd.test', 'h') RETURNING id",
    );
    await f.owner(
      "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, 'owner')",
      [org?.id, account?.id],
    );
    await f.owner(
      `INSERT INTO staff_email_change (staff_user_id, organizer_id, identity_check, reason, old_email, new_email,
         token_hash, stop_hash, code_hash, created_at, expires_at, state, applies_at)
       VALUES ($1, $2, 'other', 'Lost the old mailbox.', 'held.owner@najd.test', 'held.new@mail.test',
         sha256(gen_random_uuid()::text::bytea), sha256(gen_random_uuid()::text::bytea), sha256(gen_random_uuid()::text::bytea), now() - interval '2 days',
         now() - interval '2 days' + interval '60 minutes', 'held', now() - interval '1 minute')`,
      [account?.id, org?.id],
    );
    expect((await run()).applied).toBe(1);
    expect(mail.to("held.new@mail.test")).toHaveLength(1);
    expect(mail.to("held.owner@najd.test")[0]?.text).toContain("h•••@m•••.test");
  });
});
