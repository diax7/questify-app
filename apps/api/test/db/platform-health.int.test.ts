import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HealthFacts, PlatformNumbers } from "@questify/shared";
import type { RequestContext } from "#src/db/context";
import { pushFixture, sqlstate, type PushFixture } from "#test/support/push";
import { TEST_DATABASE_URL, addMember } from "#test/support/test-db";

type SessionRow = {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  userAgent: string | null;
  ip: string | null;
};
type AccountRow = { id: string; email: string; status: string; sessions: number };

/**
 * The console's platform doors (T-709, migration 0117): health (FR-1783), numbers (FR-1419) and the admin accounts with
 * their sessions and the forced sign-out (FR-1785). Counts and flags only; every door is for an active platform admin
 * and answers QE403 to any other seat; the one write ends an open admin session with a reason and an audit entry.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)(
  "platform health, numbers and admin sessions (database)",
  () => {
    let f: PushFixture;
    let adminId = "";
    let admin: RequestContext = {};
    beforeAll(async () => {
      f = await pushFixture();
      adminId = await newAdmin("ops@questify.test");
      admin = { isAdmin: true, staffUserId: adminId };
    });
    afterAll(async () => {
      await f.close();
    });

    async function newAdmin(email: string, status = "active"): Promise<string> {
      const [row] = await f.owner<{ id: string }>(
        "INSERT INTO staff_user (email, password_hash, platform_role, status) VALUES ($1, 'h', 'admin', $2) RETURNING id",
        [email, status],
      );
      return row?.id ?? "";
    }
    const health = async (): Promise<HealthFacts> =>
      (await f.run<{ r: HealthFacts }>(admin, "SELECT console_health() AS r"))[0]?.r as HealthFacts;
    const numbers = async (): Promise<PlatformNumbers> =>
      (await f.run<{ r: PlatformNumbers }>(admin, "SELECT console_numbers() AS r"))[0]
        ?.r as PlatformNumbers;
    const accounts = async () =>
      (await f.run<{ r: AccountRow[] }>(admin, "SELECT console_admin_accounts(900, 28800) AS r"))[0]
        ?.r ?? [];
    const sessionsOf = async (target: string) =>
      (
        await f.run<{ r: SessionRow[] }>(
          admin,
          "SELECT console_admin_sessions($1, 900, 28800) AS r",
          [target],
        )
      )[0]?.r ?? [];
    const openSession = async (
      user: string,
      options: Readonly<{ idleSeconds?: number; ageSeconds?: number; revoked?: boolean }> = {},
    ): Promise<string> => {
      const [row] = await f.owner<{ id: string }>(
        `INSERT INTO staff_session (staff_user_id, token_hash, created_at, last_seen_at, revoked_at, user_agent, ip)
       VALUES ($1, $2, now() - make_interval(secs => $3), now() - make_interval(secs => $4),
               CASE WHEN $5 THEN now() ELSE NULL END, 'Mozilla/5.0 (Macintosh) Test', '203.0.113.7')
       RETURNING id`,
        [
          user,
          randomBytes(32),
          options.ageSeconds ?? 60,
          options.idleSeconds ?? 5,
          options.revoked ?? false,
        ],
      );
      return row?.id ?? "";
    };

    /** One queued, sending or finished push, with its age in seconds (a fresh player, device, notice and center row). */
    const pushRow = async (
      state: "queued" | "sending" | "failed" | "sent",
      ago: Readonly<{ created?: number; lease?: number; finished?: number }> = {},
    ): Promise<void> => {
      const player = await f.newPlayer();
      const family = randomUUID();
      const [device] = await f.owner<{ id: string }>(
        `INSERT INTO push_device (player_id, family, platform, token, language, app_version)
       VALUES ($1, $2, 'android', $3, 'en', '1.0.0') RETURNING id`,
        [player, family, `tok_${randomUUID().replaceAll("-", "")}`],
      );
      const kind = await f.kind();
      const notice = await f.notice(kind, { player });
      const [center] = await f.owner<{ id: string }>(
        "INSERT INTO notification (notice_id, player_id) VALUES ($1, $2) RETURNING id",
        [notice, player],
      );
      await f.owner(
        `INSERT INTO push_send (notification_id, device_id, notice_id, target, priority, expires_at, state,
                              lease_token, lease_until, created_at, finished_at)
       VALUES ($1, $2, $3, 'fcm', 0, now() + interval '1 day', $4,
               CASE WHEN $4 = 'sending' THEN gen_random_uuid() END,
               CASE WHEN $4 = 'sending' THEN now() - make_interval(secs => $5) END,
               now() - make_interval(secs => $6),
               CASE WHEN $4 IN ('queued', 'sending') THEN NULL ELSE now() - make_interval(secs => $7) END)`,
        [
          center?.id,
          device?.id,
          notice,
          state,
          ago.lease ?? 0,
          ago.created ?? 0,
          ago.finished ?? 0,
        ],
      );
    };
    const alertRow = (state: string, ago: Readonly<{ created?: number; finished?: number }> = {}) =>
      f.owner(
        `INSERT INTO organizer_alert (organizer_id, staff_user_id, alert_type, dedupe, state, created_at, finished_at,
                                    lease_token, lease_until)
       VALUES ($1, gen_random_uuid(), 'activated', $2, $3, now() - make_interval(secs => $4),
               CASE WHEN $3 IN ('queued', 'sending') THEN NULL ELSE now() - make_interval(secs => $5) END,
               CASE WHEN $3 = 'sending' THEN gen_random_uuid() END,
               CASE WHEN $3 = 'sending' THEN now() - interval '10 minutes' END)`,
        [f.ids.orgA, randomUUID(), state, ago.created ?? 0, ago.finished ?? 0],
      );

    describe("who may ask", () => {
      it("refuses every seat that is not an active platform admin with QE403", async () => {
        const editor = await addMember(f.db.owner, f.ids.orgA, "editor");
        const disabled = await newAdmin("off@questify.test", "disabled");
        const seats: RequestContext[] = [
          f.team(),
          f.team(editor),
          { playerId: await f.newPlayer() },
          { isAdmin: true },
          { isAdmin: true, staffUserId: editor },
          { isAdmin: true, staffUserId: disabled },
          { staffUserId: adminId },
          {},
        ];
        const calls = [
          "SELECT console_health()",
          "SELECT console_numbers()",
          "SELECT console_admin_accounts(900, 28800)",
          `SELECT console_admin_sessions('${adminId}', 900, 28800)`,
          `SELECT admin_end_session('${randomUUID()}', 'A long enough reason', '${randomUUID()}')`,
        ];
        for (const seat of seats) {
          for (const call of calls) {
            expect(await sqlstate(f.run(seat, call)), `${call} ${JSON.stringify(seat)}`).toBe(
              "QE403",
            );
          }
        }
      });
    });

    describe("health", () => {
      it("counts live, scheduled and suspended events and the ones past their start or end", async () => {
        const before = (await health()).events;
        await f.newEvent({ phase: "live" });
        const scheduled = await f.newEvent({ phase: "scheduled" });
        const late = await f.newEvent({ phase: "scheduled" });
        await f.owner(
          "UPDATE event SET starts_at = now() - interval '10 minutes', ends_at = now() + interval '1 day' WHERE id = $1",
          [late],
        );
        await f.owner(
          "UPDATE event SET suspended_at = now(), suspended_by = $2, suspension_reason = 'For a test run' WHERE id = $1",
          [scheduled, adminId],
        );
        const after = (await health()).events;
        expect(after.live - before.live).toBe(2);
        expect(after.scheduled - before.scheduled).toBe(1);
        expect(after.suspended - before.suspended).toBe(1);
        expect(after.overdue - before.overdue).toBe(1);
      });

      it("does not call an event late within two minutes of its start or end", async () => {
        const before = (await health()).events.overdue;
        const justStarted = await f.newEvent({ phase: "scheduled" });
        await f.owner(
          "UPDATE event SET starts_at = now() - interval '30 seconds', ends_at = now() + interval '1 day' WHERE id = $1",
          [justStarted],
        );
        const justEnded = await f.newEvent({ phase: "live" });
        await f.owner(
          "UPDATE event SET starts_at = now() - interval '1 day', ends_at = now() - interval '30 seconds' WHERE id = $1",
          [justEnded],
        );
        expect((await health()).events.overdue).toBe(before);
      });

      it("lists the five busiest live events by points entries in the last hour", async () => {
        const busy = await f.newEvent({ phase: "live" });
        const player = await f.newPlayer();
        const enrollment = await f.join(busy, player);
        await f.earn(busy, enrollment);
        await f.earn(busy, enrollment);
        await f.earn(busy, enrollment, { at: new Date(Date.now() - 2 * 3600 * 1000) });
        const { busiest } = (await health()).events;
        expect(busiest.length).toBeLessThanOrEqual(5);
        expect(busiest[0]).toMatchObject({ id: busy, entries: 2, organizer: "Najd Events" });
      });

      it("reads the push queue: how many wait, the oldest, leases that ran out and failures of the day", async () => {
        const before = (await health()).push;
        await pushRow("queued", { created: 120 });
        await pushRow("queued", { created: 30 });
        await pushRow("sending", { lease: 600 });
        await pushRow("sending", { lease: 30 });
        await pushRow("failed", { finished: 60 });
        await pushRow("failed", { finished: 3 * 86_400 });
        await pushRow("sent", { finished: 10 });
        const after = (await health()).push;
        expect(after.queued - before.queued).toBe(2);
        expect(after.oldestSeconds).toBeGreaterThanOrEqual(120);
        expect(after.stuck - before.stuck).toBe(1);
        expect(after.failedDay - before.failedDay).toBe(1);
      });

      it("reads the alert emails the same way, counting failed and uncertain ones", async () => {
        const before = (await health()).alerts;
        await alertRow("queued", { created: 300 });
        await alertRow("sending");
        await alertRow("failed", { finished: 100 });
        await alertRow("uncertain", { finished: 100 });
        await alertRow("sent", { finished: 100 });
        await alertRow("failed", { finished: 2 * 86_400 });
        const after = (await health()).alerts;
        expect(after.queued - before.queued).toBe(1);
        expect(after.oldestSeconds).toBeGreaterThanOrEqual(300);
        expect(after.stuck - before.stuck).toBe(1);
        expect(after.failedDay - before.failedDay).toBe(2);
      });

      it("reads the notice fan-out, the souvenir work and the invitation sends", async () => {
        const before = await health();
        const kind = await f.kind();
        await f.notice(kind, { player: await f.newPlayer() });
        const failing = await f.notice(kind, { player: await f.newPlayer() });
        await f.owner("UPDATE notice SET fan_failures = 2 WHERE id = $1", [failing]);

        const event = await f.newEvent({ phase: "live" });
        const enrollments = [
          await f.join(event, await f.newPlayer()),
          await f.join(event, await f.newPlayer()),
        ];
        await f.owner(
          "INSERT INTO souvenir_work (event_id, enrollment_id, error_code) VALUES ($1, $2, 'E500'), ($1, $3, NULL)",
          [event, enrollments[0], enrollments[1]],
        );
        await f.owner(
          "UPDATE souvenir_work SET lease_token = gen_random_uuid(), lease_until = now() - interval '9 minutes' WHERE enrollment_id = $1",
          [enrollments[0]],
        );

        await f.owner(
          `INSERT INTO invitation_campaign (organizer_id, event_id, request_id, fingerprint, size, state, started_at, sent,
                                          failed, unknown, channels, cap, send_at, name_en)
         VALUES ($1, $2, gen_random_uuid(), 'x', 50, 'sending', now() - interval '1 day', 30, 5, 2, ARRAY['sms'], 50,
                 now(), 'Health test')`,
          [f.ids.orgA, event],
        );
        const [campaign] = await f.owner<{ id: string }>(
          "SELECT id FROM invitation_campaign WHERE name_en = 'Health test'",
        );
        await f.owner(
          `INSERT INTO invitation_recipient (campaign_id, player_id, channel, state, lease_token, lease_until, sent_at)
         VALUES ($1, gen_random_uuid(), 'sms', 'sending', gen_random_uuid(), now() - interval '20 minutes', now()),
                ($1, gen_random_uuid(), 'sms', 'sending', gen_random_uuid(), now() + interval '1 minute', now())`,
          [campaign?.id],
        );

        const after = await health();
        expect(after.fanOut.waiting - before.fanOut.waiting).toBe(2);
        expect(after.fanOut.failing - before.fanOut.failing).toBe(1);
        expect(after.fanOut.oldestSeconds).not.toBeNull();
        expect(after.souvenirs.waiting - before.souvenirs.waiting).toBe(2);
        expect(after.souvenirs.failing - before.souvenirs.failing).toBe(1);
        expect(after.souvenirs.stuck - before.souvenirs.stuck).toBe(1);
        expect(after.invitations.sending - before.invitations.sending).toBe(1);
        expect(after.invitations.stuck - before.invitations.stuck).toBe(1);
        expect(after.invitations.sentWeek - before.invitations.sentWeek).toBe(30);
        expect(after.invitations.failedWeek - before.invitations.failedWeek).toBe(5);
        expect(after.invitations.unknownWeek - before.invitations.unknownWeek).toBe(2);
      });

      it("lists the channels a provider refusal has paused, and not the ones whose pause is over", async () => {
        await f.owner(
          `INSERT INTO invitation_channel_hold (channel, hold_until, code)
         VALUES ('sms', now() + interval '10 minutes', 'M0037'), ('email', now() - interval '1 minute', 'old')`,
        );
        const { holds } = await health();
        expect(holds).toHaveLength(1);
        expect(holds[0]).toMatchObject({ channel: "sms", code: "M0037" });
      });

      it("stops every count at 10,001 so a backlog of millions costs the same as ten thousand", async () => {
        await f.owner(
          `INSERT INTO organizer_alert (organizer_id, staff_user_id, alert_type, dedupe)
         SELECT $1, gen_random_uuid(), 'activated', 'cap-' || g FROM generate_series(1, 10100) g`,
          [f.ids.orgA],
        );
        expect((await health()).alerts.queued).toBe(10_001);
        await f.owner("DELETE FROM organizer_alert WHERE dedupe LIKE 'cap-%'");
      });

      it("finds the oldest waiting push and notice past 10,001 rows, where a capped sample would miss it", async () => {
        const kind = await f.kind();
        await f.owner("SET session_replication_role = replica");
        try {
          await f.owner(
            `INSERT INTO push_send (notification_id, device_id, notice_id, target, priority, expires_at, created_at)
             SELECT -g, gen_random_uuid(), 0, 'fcm', 0, now() + interval '1 day',
                    CASE WHEN g = 10002 THEN now() - interval '1 day' ELSE now() - interval '1 minute' END
             FROM generate_series(1, 10002) g`,
          );
        } finally {
          await f.owner("SET session_replication_role = origin");
        }
        await f.owner(
          `INSERT INTO notice (kind, audience, dedupe, expires_at, created_at)
           SELECT $1, 'player', 'oldest-' || g, now() + interval '1 day',
                  CASE WHEN g = 10002 THEN now() - interval '1 day' ELSE now() - interval '1 minute' END
           FROM generate_series(1, 10002) g`,
          [kind],
        );
        try {
          const { push, fanOut } = await health();
          expect(push.queued).toBe(10_001);
          expect(push.oldestSeconds).toBeGreaterThanOrEqual(86_000);
          expect(fanOut.waiting).toBe(10_001);
          expect(fanOut.oldestSeconds).toBeGreaterThanOrEqual(86_000);
        } finally {
          await f.owner("DELETE FROM push_send WHERE notification_id < 0");
          await f.owner("DELETE FROM notice WHERE dedupe LIKE 'oldest-%'");
        }
      });

      it("reads the oldest waiting push and notice through an index, not a scan of the queue", async () => {
        await f.owner("BEGIN");
        try {
          await f.owner("SET LOCAL enable_seqscan = off");
          const plans: string[] = [];
          for (const sql of [
            "SELECT created_at FROM push_send WHERE state = 'queued' ORDER BY created_at LIMIT 1",
            "SELECT created_at FROM notice WHERE fanned_at IS NULL AND fan_failures = 0 ORDER BY created_at LIMIT 1",
          ]) {
            const lines = await f.owner<Record<string, unknown>>(`EXPLAIN ${sql}`);
            plans.push(lines.map((line) => String(line["QUERY PLAN"])).join(" "));
          }
          expect(plans[0]).toMatch(/push_send_queued_oldest/);
          expect(plans[1]).toMatch(/notice_unfanned_oldest/);
          expect(plans.join(" ")).not.toMatch(/Sort/);
        } finally {
          await f.owner("ROLLBACK");
        }
      });

      it("answers with ids, names and counts only: no contact, token or text", async () => {
        const text = JSON.stringify(await health());
        expect(text).not.toMatch(/@|token|password|phone/i);
      });
    });

    describe("numbers", () => {
      it("counts organizers, events, players and staff by status", async () => {
        const before = await numbers();
        const [org] = await f.owner<{ id: string }>(
          "INSERT INTO organizer (name, slug) VALUES ('Paused Org', 'paused-org') RETURNING id",
        );
        await f.run(admin, "SELECT admin_suspend_organizer($1, 'Paused for the count test', $2)", [
          org?.id,
          randomUUID(),
        ]);
        await f.newEvent({ phase: "archived" });
        await f.newEvent({ phase: "scheduled" });
        const banned = await f.newPlayer();
        await f.owner("UPDATE player SET status = 'banned' WHERE id = $1", [banned]);
        const erased = await f.newPlayer();
        await f.erase(erased);
        await f.newPlayer();
        const after = await numbers();
        expect(after.organizers.paused - before.organizers.paused).toBe(1);
        expect(after.events.archived - before.events.archived).toBe(1);
        expect(after.events.scheduled - before.events.scheduled).toBe(1);
        expect(after.players.banned - before.players.banned).toBe(1);
        expect(after.players.active - before.players.active).toBe(1);
        expect(after.players.joinedWeek - before.players.joinedWeek).toBe(2);
        expect(after.staff.accounts).toBeGreaterThan(before.staff.accounts - 1);
        expect(after.staff.admins).toBeGreaterThanOrEqual(1);
      });

      it("counts the players seated in live events and the points entries of the last hour", async () => {
        const before = await numbers();
        const live = await f.newEvent({ phase: "live" });
        const ended = await f.newEvent({ phase: "ended" });
        await f.owner("UPDATE event SET ends_at = now() - interval '1 minute' WHERE id = $1", [
          ended,
        ]);
        const enrolled = await f.join(live, await f.newPlayer());
        await f.earn(live, enrolled);
        await f.earn(live, enrolled, { at: new Date(Date.now() - 3 * 3600 * 1000) });
        await f.join(ended, await f.newPlayer());
        const after = await numbers();
        expect(after.activity.playersInLiveEvents - before.activity.playersInLiveEvents).toBe(1);
        expect(after.activity.entriesHour - before.activity.entriesHour).toBe(1);
      });

      it("leaves out the review demo: its organizer, its events and the accounts it made (Q-525)", async () => {
        const [org] = await f.owner<{ id: string }>(
          "INSERT INTO organizer (name, slug) VALUES ('Questify Review Demo', 'review-demo-numbers') RETURNING id",
        );
        const demoEvent = await f.newEvent({ phase: "live", organizer: org?.id ?? "" });
        const account = await f.newPlayer();
        await f.join(demoEvent, account);
        const shown = await numbers();
        await f.owner(
          `INSERT INTO review_demo (organizer_id, event_id, contact, contact_key, contact_fp, created_by)
           VALUES ($1, $2, '+966500000000', $3, $3, $4)`,
          [org?.id, demoEvent, Buffer.alloc(32, 1), adminId],
        );
        await f.owner("INSERT INTO review_demo_player (player_id, role) VALUES ($1, 'fictional')", [
          account,
        ]);
        const after = await numbers();
        expect(after.organizers.active).toBe(shown.organizers.active - 1);
        expect(after.events.live).toBe(shown.events.live - 1);
        expect(after.players.active).toBe(shown.players.active - 1);
        expect(after.activity.playersInLiveEvents).toBe(shown.activity.playersInLiveEvents - 1);
      });

      it("holds nothing but counts", async () => {
        const text = JSON.stringify(await numbers());
        expect(text).not.toMatch(/@|username|email|name/i);
      });
    });

    describe("admin accounts and sessions", () => {
      it("lists platform admins only, with their open sessions: not revoked, within the idle and age limits", async () => {
        const other = await newAdmin("night@questify.test");
        await openSession(other);
        await openSession(other);
        await openSession(other, { revoked: true });
        await openSession(other, { idleSeconds: 901 });
        await openSession(other, { ageSeconds: 28_801, idleSeconds: 10 });
        const member = await addMember(f.db.owner, f.ids.orgB, "editor");
        await openSession(member);
        const list = await accounts();
        expect(list.find((row) => row.id === other)).toMatchObject({
          email: "night@questify.test",
          status: "active",
          sessions: 2,
        });
        expect(list.find((row) => row.id === member)).toBeUndefined();
        const emails = list.map((row) => row.email);
        expect(emails).toEqual(emails.toSorted((a, b) => a.localeCompare(b)));
        expect(JSON.stringify(list)).not.toMatch(/password|hash/i);
      });

      it("shows a disabled admin account too, so nobody is missing from the list", async () => {
        const off = await newAdmin("gone@questify.test", "disabled");
        expect((await accounts()).find((row) => row.id === off)).toMatchObject({
          status: "disabled",
        });
      });

      it("lists one admin's open sessions newest first with their browser and address, never a token", async () => {
        const other = await newAdmin("lost-laptop@questify.test");
        const older = await openSession(other, { ageSeconds: 600 });
        const newer = await openSession(other, { ageSeconds: 30 });
        await openSession(other, { revoked: true });
        const rows = await sessionsOf(other);
        expect(rows.map((row) => row.id)).toEqual([newer, older]);
        expect(rows[0]).toMatchObject({
          userAgent: "Mozilla/5.0 (Macintosh) Test",
          ip: "203.0.113.7",
        });
        expect(Object.keys(rows[0] ?? {}).toSorted()).toEqual([
          "createdAt",
          "id",
          "ip",
          "lastSeenAt",
          "userAgent",
        ]);
      });

      it("answers QA404 for an account that is not a platform admin or does not exist", async () => {
        const member = await addMember(f.db.owner, f.ids.orgB, "editor");
        for (const target of [member, randomUUID()]) {
          expect(
            await sqlstate(f.run(admin, "SELECT console_admin_sessions($1, 900, 28800)", [target])),
          ).toBe("QA404");
        }
      });

      it("ends an open session at once, with the reason and whose it was in the audit log", async () => {
        const other = await newAdmin("stolen@questify.test");
        const session = await openSession(other);
        const request = randomUUID();
        await f.run(admin, "SELECT admin_end_session($1, $2, $3)", [
          session,
          "  Laptop lost at the airport  ",
          request,
        ]);
        const [row] = await f.owner<{ revoked_at: Date | null }>(
          "SELECT revoked_at FROM staff_session WHERE id = $1",
          [session],
        );
        expect(row?.revoked_at).not.toBeNull();
        expect((await sessionsOf(other)).map((r) => r.id)).not.toContain(session);
        const [audit] = await f.owner<{
          actor_type: string;
          actor_id: string;
          action: string;
          target_type: string;
          target_id: string;
          after: Record<string, unknown>;
          request_id: string;
        }>(
          "SELECT actor_type, actor_id, action, target_type, target_id, after, request_id FROM audit_log WHERE target_id = $1 AND action = 'staff.session.force_end'",
          [session],
        );
        expect(audit).toMatchObject({
          actor_type: "admin",
          actor_id: adminId,
          target_type: "staff_session",
          request_id: request,
          after: { reason: "Laptop lost at the airport", staffUserId: other },
        });
        expect(JSON.stringify(audit)).not.toMatch(/token|203\.0\.113/);
      });

      it("can end an admin's own other session, and refuses a second end of the same session", async () => {
        const mine = await openSession(adminId);
        const door = "SELECT admin_end_session($1, 'Signed in on a shared computer', $2)";
        await f.run(admin, door, [mine, randomUUID()]);
        expect(await sqlstate(f.run(admin, door, [mine, randomUUID()]))).toBe("QA404");
      });

      it("refuses a reason that is too short, too long or empty, and ends nothing", async () => {
        const other = await newAdmin("reasons@questify.test");
        const session = await openSession(other);
        for (const reason of ["", "short", "   too short  ", "x".repeat(301)]) {
          expect(
            await sqlstate(
              f.run(admin, "SELECT admin_end_session($1, $2, $3)", [session, reason, randomUUID()]),
            ),
            reason,
          ).toBe("SU400");
        }
        const [row] = await f.owner<{ revoked_at: Date | null }>(
          "SELECT revoked_at FROM staff_session WHERE id = $1",
          [session],
        );
        expect(row?.revoked_at).toBeNull();
      });

      it("never ends the session of an organizer's member, or one that does not exist", async () => {
        const member = await addMember(f.db.owner, f.ids.orgA, "editor");
        const theirs = await openSession(member);
        for (const target of [theirs, randomUUID()]) {
          expect(
            await sqlstate(
              f.run(admin, "SELECT admin_end_session($1, 'A reason long enough', $2)", [
                target,
                randomUUID(),
              ]),
            ),
          ).toBe("QA404");
        }
        const [row] = await f.owner<{ revoked_at: Date | null }>(
          "SELECT revoked_at FROM staff_session WHERE id = $1",
          [theirs],
        );
        expect(row?.revoked_at).toBeNull();
      });

      it("does not let an ended admin session be revived", async () => {
        const other = await newAdmin("revive@questify.test");
        const session = await openSession(other);
        await f.run(admin, "SELECT admin_end_session($1, 'Reason that is long enough', $2)", [
          session,
          randomUUID(),
        ]);
        expect(
          await sqlstate(
            f.owner("UPDATE staff_session SET revoked_at = NULL WHERE id = $1", [session]),
          ),
        ).toBe("23514");
      });
    });
  },
);
