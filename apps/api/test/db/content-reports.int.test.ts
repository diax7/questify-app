import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RequestContext } from "#src/db/context";
import { pushFixture, sqlstate, type PushFixture } from "#test/support/push";
import { TEST_DATABASE_URL, addMember, connectAsOwner } from "#test/support/test-db";

type Report = Readonly<{
  kind: string;
  target: string | null;
  name?: string | null;
  event?: string | null;
  reason?: string;
  note?: string | null;
}>;
type Hold = Readonly<{ outcome: string; hold_id: string }>;

const NOTE = "Shows a slur in the quest title.";

/**
 * Reports and moderation in the database (T-705b, migration 0121): a player reports what they can see, once while it
 * is open and within the caps; a reported username in an event also opens the team's ticket; the console groups the
 * open reports, closes them all at once and lists open flags; an admin unpublishes a quest, a reward or an announcement
 * (players stop seeing it, the team cannot show it again, the organizer is alerted with ids only) and publishes it
 * again; erasure and the 180-day purge.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("reports and moderation (database)", () => {
  let f: PushFixture;
  let admin: RequestContext = {};
  let adminId = "";
  beforeAll(async () => {
    f = await pushFixture();
    const [made] = await f.owner<{ id: string }>(
      "INSERT INTO staff_user (email, password_hash, platform_role) VALUES ('mod@questify.test', 'h', 'admin') RETURNING id",
    );
    adminId = made?.id ?? "";
    admin = { isAdmin: true, staffUserId: adminId };
  });
  afterAll(async () => {
    await f.close();
  });

  const report = (player: string, r: Report) =>
    f.one<string>({ playerId: player }, "SELECT report_content($1, $2, $3, $4, $5, $6) AS r", [
      r.kind,
      r.target,
      r.name ?? null,
      r.event ?? null,
      r.reason ?? "offensive",
      r.note ?? null,
    ]);
  const unpublish = async (kind: string, target: string, seat = admin) =>
    (
      await f.run<Hold>(seat, "SELECT * FROM admin_unpublish($1, $2, 'offensive', $3, $4)", [
        kind,
        target,
        NOTE,
        randomUUID(),
      ])
    )[0];
  const republish = (kind: string, target: string, seat = admin) =>
    f.one<string>(seat, "SELECT admin_republish($1, $2, $3, $4) AS r", [
      kind,
      target,
      "The organizer fixed the text.",
      randomUUID(),
    ]);
  const resolve = (kind: string, target: string, outcome: string) =>
    f.one<number>(admin, "SELECT admin_report_resolve($1, $2, $3, $4) AS r", [
      kind,
      target,
      outcome,
      randomUUID(),
    ]);
  const live = () => f.newEvent({ phase: "live" });
  const member = async (event: string) => {
    const player = await f.newPlayer();
    return { player, enrollment: await f.join(event, player) };
  };
  const quest = async (event: string, title = "Find the falcon") =>
    (
      await f.owner<{ id: string }>(
        `INSERT INTO quest (event_id, category_id, type, title_en, title_ar, points, visible, type_config)
         SELECT $1, id, 'scan_qr', $2, 'ابحث عن الصقر', 10, true, '{}' FROM category WHERE event_id = $1 LIMIT 1
         RETURNING id`,
        [event, title],
      )
    )[0]?.id ?? "";
  const reward = async (event: string) =>
    (
      await f.owner<{ id: string }>(
        "INSERT INTO reward (event_id, kind, name_en, price, stock_total) VALUES ($1, 'item', 'Hoodie', 20, 5) RETURNING id",
        [event],
      )
    )[0]?.id ?? "";
  const reportsOf = (target: string) =>
    f.owner<{
      status: string;
      outcome: string | null;
      reporter_id: string | null;
      snapshot: object;
    }>(
      "SELECT status, outcome, reporter_id, snapshot FROM content_report WHERE target_id = $1 ORDER BY created_at",
      [target],
    );

  describe("seats", () => {
    it("refuses every console door to anyone but an active platform admin", async () => {
      const event = await live();
      const seats: RequestContext[] = [
        {},
        { playerId: await f.newPlayer() },
        f.team(),
        { isAdmin: true },
      ];
      for (const seat of seats) {
        for (const [sql, values] of [
          ["SELECT console_reports(NULL, $1)", [randomUUID()]],
          ["SELECT console_report('event', $1, $2)", [event, randomUUID()]],
          ["SELECT admin_report_resolve('event', $1, 'dismissed', $2)", [event, randomUUID()]],
          ["SELECT console_flags($1)", [randomUUID()]],
          [
            "SELECT * FROM admin_unpublish('quest', $1, 'spam', $2, $3)",
            [event, NOTE, randomUUID()],
          ],
          ["SELECT admin_republish('quest', $1, $2, $3)", [event, NOTE, randomUUID()]],
        ] as const) {
          expect(await sqlstate(f.run(seat, sql, [...values])), sql).toBe("QE403");
        }
      }
    });

    it("leaves the API's role no write on reports, holds or a reward's hold", async () => {
      const event = await live();
      const prize = await reward(event);
      for (const sql of [
        "SELECT * FROM content_report",
        "INSERT INTO content_hold (kind, target_id, organizer_id, event_id, reason_code, note, held_by) VALUES ('reward', gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'spam', 'long enough note', gen_random_uuid())",
        `UPDATE reward SET held_at = now() WHERE id = '${prize}'`,
      ]) {
        expect(await sqlstate(f.run(f.team(), sql)), sql).toBe("42501");
      }
    });
  });

  describe("reporting", () => {
    it("takes a report of what the member sees, once while open, and keeps what was reported", async () => {
      const event = await live();
      const { player } = await member(event);
      const target = await quest(event, "Rude title");
      expect(await report(player, { kind: "quest", target, note: "  Look at the title.  " })).toBe(
        "reported",
      );
      expect(await report(player, { kind: "quest", target })).toBe("already_reported");
      await f.owner("UPDATE quest SET title_en = 'Clean title' WHERE id = $1", [target]);
      await f.owner("DELETE FROM quest WHERE id = $1", [target]);
      const [row] = await reportsOf(target);
      expect(row).toMatchObject({
        status: "open",
        reporter_id: player,
        snapshot: { title: { en: "Rude title", ar: "ابحث عن الصقر" } },
      });
      const [note] = await f.owner<{ note: string; event_id: string }>(
        "SELECT note, event_id FROM content_report WHERE target_id = $1",
        [target],
      );
      expect(note).toEqual({ note: "Look at the title.", event_id: event });
    });

    it("answers not found for anything the reporter cannot see, with no oracle", async () => {
      const event = await live();
      const elsewhere = await live();
      const { player } = await member(event);
      const hidden = await quest(event);
      await f.owner("UPDATE quest SET visible = false WHERE id = $1", [hidden]);
      const foreign = await quest(elsewhere);
      const gone = await reward(event);
      await f.owner("UPDATE reward SET status = 'removed' WHERE id = $1", [gone]);
      for (const r of [
        { kind: "quest", target: hidden },
        { kind: "quest", target: foreign },
        { kind: "quest", target: randomUUID() },
        { kind: "reward", target: gone },
        { kind: "event", target: elsewhere },
        { kind: "username", target: null, name: "nobody_here" },
        { kind: "username", target: null, name: await f.usernameOf(player) },
      ]) {
        expect(await sqlstate(report(player, r)), JSON.stringify(r)).toBe("RP404");
      }
      expect(await sqlstate(report(player, { kind: "image", target: event }))).toBe("RP422");
      expect(await sqlstate(report(player, { kind: "event", target: event, reason: "rude" }))).toBe(
        "RP422",
      );
      expect(
        await sqlstate(report(player, { kind: "event", target: event, note: "x".repeat(501) })),
      ).toBe("RP422");
      expect(
        await sqlstate(report(player, { kind: "event", target: event, note: "bad‮text" })),
      ).toBe("SV422");
      const banned = await member(event);
      await f.owner("UPDATE player SET status = 'banned' WHERE id = $1", [banned.player]);
      expect(await sqlstate(report(banned.player, { kind: "event", target: event }))).toBe("42501");
    });

    it("marks a note the word lists catch, never refuses it", async () => {
      const event = await live();
      const { player } = await member(event);
      await f.owner(
        "INSERT INTO username_word (word, match, language) VALUES ('gnarlword', 'word', 'en') ON CONFLICT DO NOTHING",
      );
      expect(
        await report(player, { kind: "event", target: event, note: "it says gnarlword" }),
      ).toBe("reported");
      const [row] = await f.owner<{ marked: boolean }>(
        "SELECT marked FROM content_report WHERE target_id = $1 AND reporter_id = $2",
        [event, player],
      );
      expect(row?.marked).toBe(true);
    });

    it("holds ten an hour and thirty a day, even when sent at once", async () => {
      const event = await live();
      const { player } = await member(event);
      const quests = await Promise.all(Array.from({ length: 12 }, () => quest(event)));
      const outcomes = await Promise.all(
        quests.map((target) => sqlstate(report(player, { kind: "quest", target }))),
      );
      expect(outcomes.filter((one) => one === "none")).toHaveLength(10);
      expect(outcomes.filter((one) => one === "RP429")).toHaveLength(2);
      const other = await member(event);
      await f.owner(
        `INSERT INTO content_report (reporter_id, event_id, target_kind, target_id, snapshot, reason, created_at)
         SELECT $1, $2, 'event', gen_random_uuid(), '{}', 'spam', now() - interval '3 hours'
         FROM generate_series(1, 30)`,
        [other.player, event],
      );
      const failure = await f
        .run(
          { playerId: other.player },
          "SELECT report_content('event', $1, NULL, NULL, 'spam', NULL)",
          [event],
        )
        .then(
          () => "none",
          (error: { code?: string; detail?: string }) => `${error.code}:${error.detail}`,
        );
      expect(failure).toBe("RP429:day");
    });

    it("sends a username reported in an event to the team too, in the same transaction", async () => {
      const event = await live();
      const reporter = await member(event);
      const reported = await member(event);
      const name = await f.usernameOf(reported.player);
      expect(
        await report(reporter.player, {
          kind: "username",
          target: null,
          name,
          event,
          reason: "hateful",
        }),
      ).toBe("reported");
      const tickets = await f.owner<{ kind: string; reported_enrollment_id: string; body: string }>(
        "SELECT kind, reported_enrollment_id, body FROM ticket WHERE player_id = $1",
        [reporter.player],
      );
      expect(tickets).toHaveLength(1);
      expect(tickets[0]).toMatchObject({
        kind: "report_player",
        reported_enrollment_id: reported.enrollment,
      });
      expect(tickets[0]?.body).toContain("hateful");
      expect(tickets[0]?.body).not.toContain(name);
      const [row] = await reportsOf(reported.player);
      expect(row?.snapshot).toEqual({ username: name });
      // Outside an event: Questify's queue only.
      const loner = await f.newPlayer();
      expect(await report(loner, { kind: "username", target: null, name })).toBe("reported");
      expect(await f.count("ticket WHERE player_id = $1", [loner])).toBe(0);
      // A member who is not in the event cannot name an event for it.
      expect(await sqlstate(report(loner, { kind: "username", target: null, name, event }))).toBe(
        "RP404",
      );
    });
  });

  describe("the queue", () => {
    it("groups open reports per target, oldest first, and closes them all with one outcome", async () => {
      const event = await live();
      const target = await quest(event, "Grouped");
      const [a, b] = [await member(event), await member(event)];
      await report(a.player, { kind: "quest", target, reason: "spam" });
      await report(b.player, { kind: "quest", target, reason: "misleading", note: "Wrong prize" });
      await f.owner(
        `UPDATE content_report SET created_at = now() - interval '25 hours', due_at = now() - interval '24 hours'
         WHERE target_id = $1 AND reporter_id = $2`,
        [target, a.player],
      );
      const queue = await f.one<{ targets: Record<string, unknown>[]; total: number }>(
        admin,
        "SELECT console_reports('quest', $1) AS r",
        [randomUUID()],
      );
      const row = queue.targets.find((one) => one["targetId"] === target);
      expect(row).toMatchObject({
        kind: "quest",
        reports: 2,
        urgent: true,
        overdue: true,
        snapshot: { title: { en: "Grouped" } },
        event: { id: event },
      });
      const detail = await f.one<{ reports: Record<string, unknown>[]; current: unknown }>(
        admin,
        "SELECT console_report('quest', $1, $2) AS r",
        [target, randomUUID()],
      );
      expect(detail.reports.map((one) => one["reporter"]).toSorted()).toEqual(
        [await f.usernameOf(a.player), await f.usernameOf(b.player)].toSorted(),
      );
      expect(detail.current).toMatchObject({ title: { en: "Grouped" } });
      expect(await sqlstate(resolve("quest", target, "nothing"))).toBe("RP422");
      expect(await resolve("quest", target, "dismissed")).toBe(2);
      expect(await resolve("quest", target, "dismissed")).toBe(0);
      expect((await reportsOf(target)).map((one) => one.status)).toEqual([
        "dismissed",
        "dismissed",
      ]);
      const audits = await f.owner<{ action: string; after: unknown }>(
        "SELECT action, after FROM audit_log WHERE action IN ('console.report_read', 'report.resolve') AND target_id = $1",
        [target],
      );
      expect(audits.map((one) => one.action).toSorted()).toEqual([
        "console.report_read",
        "report.resolve",
      ]);
      expect(JSON.stringify(audits)).not.toContain(await f.usernameOf(a.player));
      expect(
        await sqlstate(
          f.run(admin, "SELECT console_report('quest', $1, $2)", [randomUUID(), randomUUID()]),
        ),
      ).toBe("QA404");
    });

    it("closes with an action only once that action is in place, and leaves the reports open otherwise (RP409)", async () => {
      const event = await live();
      const target = await quest(event, "Not yet");
      const reporter = await member(event);
      await report(reporter.player, { kind: "quest", target });
      for (const outcome of [
        "unpublished",
        "event_suspended",
        "username_changed",
        "player_banned",
      ]) {
        expect(await sqlstate(resolve("quest", target, outcome)), outcome).toBe("RP409");
      }
      expect((await reportsOf(target)).map((one) => one.status)).toEqual(["open"]);
      await unpublish("quest", target);
      await f.owner(
        `INSERT INTO content_report (reporter_id, event_id, target_kind, target_id, snapshot, reason)
         VALUES ($1, $2, 'quest', $3, '{}', 'spam')`,
        [(await member(event)).player, event, target],
      );
      expect(await resolve("quest", target, "unpublished")).toBe(1);

      await report(reporter.player, { kind: "event", target: event });
      expect(await sqlstate(resolve("event", event, "event_suspended"))).toBe("RP409");
      await f.owner(
        "UPDATE event SET suspended_at = now(), suspension_reason = 'Reported content under review.' WHERE id = $1",
        [event],
      );
      expect(await resolve("event", event, "event_suspended")).toBe(1);
      expect(await sqlstate(resolve("event", event, "unpublished"))).toBe("RP409");
    });

    it("does not take a change of case or of an Arabic letter form for a rename", async () => {
      const reported = await f.newPlayer();
      const name = `أحمد_${randomUUID().slice(0, 8)}`;
      const rename = (to: string) =>
        f.owner("UPDATE player SET username = $2 WHERE id = $1", [reported, to]);
      await rename(name);
      await report(await f.newPlayer(), { kind: "username", target: null, name });
      await rename(name.replace("أ", "ا").toUpperCase());
      expect(await sqlstate(resolve("username", reported, "username_changed"))).toBe("RP409");
      await rename(`renamed_${randomUUID().slice(0, 8)}`);
      expect(await resolve("username", reported, "username_changed")).toBe(1);
    });

    it("closes a username's reports as changed or banned only when the player was renamed or banned", async () => {
      const reported = await f.newPlayer();
      const name = await f.usernameOf(reported);
      await report(await f.newPlayer(), { kind: "username", target: null, name });
      for (const outcome of [
        "username_changed",
        "player_banned",
        "unpublished",
        "event_suspended",
      ]) {
        expect(await sqlstate(resolve("username", reported, outcome)), outcome).toBe("RP409");
      }
      await f.owner("UPDATE player SET username = $2 WHERE id = $1", [
        reported,
        `renamed_${randomUUID().slice(0, 8)}`,
      ]);
      expect(await resolve("username", reported, "username_changed")).toBe(1);

      const renamed = await f.usernameOf(reported);
      await report(await f.newPlayer(), { kind: "username", target: null, name: renamed });
      expect(await sqlstate(resolve("username", reported, "player_banned"))).toBe("RP409");
      await f.owner("UPDATE player SET status = 'banned' WHERE id = $1", [reported]);
      expect(await resolve("username", reported, "player_banned")).toBe(1);
      expect((await reportsOf(reported)).map((one) => one.outcome)).toEqual([
        "username_changed",
        "player_banned",
      ]);
    });

    it("lists the open flags of every event, grouped, read-only", async () => {
      const event = await live();
      const { enrollment } = await member(event);
      await f.owner(
        `INSERT INTO flag (organizer_id, event_id, enrollment_id, kind, evidence)
         SELECT organizer_id, $1, $2, k, '{}' FROM enrollment, unnest(ARRAY['burst', 'far_from_venue']) k
         WHERE id = $2`,
        [event, enrollment],
      );
      const flags = await f.one<{ events: Record<string, unknown>[] }>(
        admin,
        "SELECT console_flags($1) AS r",
        [randomUUID()],
      );
      expect(flags.events.find((one) => one["eventId"] === event)).toMatchObject({
        open: 2,
        kinds: ["burst", "far_from_venue"],
      });
    });
  });

  describe("unpublish", () => {
    it("takes the target's report lock before it locks the target row (migration 0176)", async () => {
      const target = await quest(await live());
      const holder = await connectAsOwner(f.db);
      try {
        await holder.query("BEGIN");
        await holder.query(
          "SELECT pg_advisory_xact_lock(hashtextextended('report_target:quest:' || $1, 0))",
          [target],
        );
        const waiting = unpublish("quest", target);
        let queued = false;
        for (let attempt = 0; attempt < 300 && !queued; attempt += 1) {
          const rows = await f.owner(
            "SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%admin_unpublish%'",
          );
          queued = rows.length > 0;
          if (!queued) await new Promise((done) => setTimeout(done, 10));
        }
        expect(queued).toBe(true);
        expect(
          await f.owner("SELECT id FROM quest WHERE id = $1 FOR UPDATE NOWAIT", [target]),
        ).toHaveLength(1);
        await holder.query("COMMIT");
        expect((await waiting)?.outcome).toBe("unpublished");
      } finally {
        await holder.query("ROLLBACK").catch(() => undefined);
        await holder.end();
      }
    });

    it("hides a quest from players, keeps the team from showing it, alerts once and closes its reports", async () => {
      const event = await live();
      const { player, enrollment } = await member(event);
      await addMember(f.db.owner, f.ids.orgA, "editor");
      const target = await quest(event);
      await report(player, { kind: "quest", target });
      const ledger = await f.count("ledger_entry WHERE event_id = $1", [event]);
      await f.owner("DELETE FROM organizer_alert");
      const [one, two] = await Promise.all([
        unpublish("quest", target),
        unpublish("quest", target),
      ]);
      expect([one?.outcome, two?.outcome].toSorted()).toEqual([
        "already_unpublished",
        "unpublished",
      ]);
      expect(one?.hold_id).toBe(two?.hold_id);
      expect(await f.count("content_hold WHERE target_id = $1", [target])).toBe(1);
      const [seen] = await f.owner<{ r: boolean }>("SELECT member_sees_quest($1, $2) AS r", [
        enrollment,
        target,
      ]);
      expect(seen?.r).toBe(false);
      expect(
        await sqlstate(f.run(f.team(), "UPDATE quest SET visible = true WHERE id = $1", [target])),
      ).toBe("HD423");
      expect(await f.count("ledger_entry WHERE event_id = $1", [event])).toBe(ledger);
      expect((await reportsOf(target))[0]).toMatchObject({
        status: "actioned",
        outcome: "unpublished",
      });
      const alerts = await f.owner<{ alert_type: string; dedupe: string }>(
        "SELECT alert_type, dedupe FROM organizer_alert",
      );
      expect(alerts.length).toBeGreaterThan(0);
      for (const alert of alerts) {
        expect(alert.alert_type).toBe("content_unpublished");
        expect(alert.dedupe).toMatch(/^hold:[0-9a-f-]{36}:[0-9a-f-]{36}$/);
      }
      const [audit] = await f.owner<{ actor_type: string; event_id: string; after: object }>(
        "SELECT actor_type, event_id, after FROM audit_log WHERE action = 'content.unpublish' AND target_id = $1",
        [target],
      );
      expect(audit).toMatchObject({
        actor_type: "admin",
        event_id: event,
        after: { reasonCode: "offensive" },
      });
      // The team reads the hold of its own event; another organizer reads nothing.
      expect(
        await f.run(f.team(), "SELECT kind FROM content_hold WHERE target_id = $1", [target]),
      ).toEqual([{ kind: "quest" }]);
      const outsider = await addMember(f.db.owner, f.ids.orgB, "owner");
      expect(
        await f.run(
          f.team(outsider, f.ids.orgB),
          "SELECT kind FROM content_hold WHERE target_id = $1",
          [target],
        ),
      ).toEqual([]);

      expect(await republish("quest", target)).toBe("republished");
      expect(await republish("quest", target)).toBe("not_unpublished");
      const [shown] = await f.owner<{ visible: boolean }>(
        "SELECT visible FROM quest WHERE id = $1",
        [target],
      );
      expect(shown?.visible).toBe(true);
      expect(await f.count("organizer_alert")).toBe(alerts.length);
    });

    it("keeps a hidden quest hidden after republish, and works on a suspended event", async () => {
      const event = await live();
      const target = await quest(event);
      await f.owner("UPDATE quest SET visible = false WHERE id = $1", [target]);
      await f.owner(
        "UPDATE event SET suspended_at = now(), suspended_by = $2, suspension_reason = 'Checking reports' WHERE id = $1",
        [event, adminId],
      );
      expect((await unpublish("quest", target))?.outcome).toBe("unpublished");
      expect(await republish("quest", target)).toBe("republished");
      const [row] = await f.owner<{ visible: boolean }>("SELECT visible FROM quest WHERE id = $1", [
        target,
      ]);
      expect(row?.visible).toBe(false);
      expect(await sqlstate(unpublish("event", target))).toBe("HD400");
      expect(await sqlstate(unpublish("quest", randomUUID()))).toBe("HD404");
      expect(
        await sqlstate(
          f.run(admin, "SELECT * FROM admin_unpublish('quest', $1, 'spam', 'short', $2)", [
            target,
            randomUUID(),
          ]),
        ),
      ).toBe("HD400");
    });

    it("takes a reward out of the shop and the reserve door, and leaves reservations collectable", async () => {
      const event = await live();
      const buyer = await member(event);
      await f.owner(
        `INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta, actor)
         SELECT organizer_id, event_id, id, 'welcome', 100, 100, 'system' FROM enrollment WHERE id = $1`,
        [buyer.enrollment],
      );
      const prize = await reward(event);
      const reserve = () =>
        f.run<{ redemption_id: string }>(
          { playerId: buyer.player },
          "SELECT * FROM reserve_reward($1, $2)",
          [prize, randomUUID()],
        );
      const first = (await reserve())[0]?.redemption_id;
      expect((await unpublish("reward", prize))?.outcome).toBe("unpublished");
      const shop = await f.run<{ id: string }>(
        { playerId: buyer.player },
        "SELECT id FROM shop_rewards($1)",
        [event],
      );
      expect(shop.map((one) => one.id)).not.toContain(prize);
      expect(await sqlstate(reserve())).toBe("RN404");
      expect(
        await sqlstate(
          f.run({ playerId: buyer.player }, "SELECT set_goal($1, $2)", [event, prize]),
        ),
      ).toBe("RN404");
      const [kept] = await f.owner<{ status: string }>(
        "SELECT status FROM redemption WHERE id = $1",
        [first],
      );
      expect(kept?.status).toBe("reserved");
      expect(await republish("reward", prize)).toBe("republished");
      expect((await reserve())[0]?.redemption_id).toBeDefined();
    });

    it("withdraws an announcement from lists and the center, and skips a scheduled one", async () => {
      const event = await live();
      const { player } = await member(event);
      const draft = {
        titleAr: "تنبيه",
        titleEn: "Notice",
        bodyAr: "نص التنبيه هنا.",
        bodyEn: "The notice text here.",
        pushBodyAr: "نص التنبيه هنا.",
        pushBodyEn: "The notice text here.",
      };
      const send = (at: Date | null) =>
        f.run<{ id: string }>(
          f.team(),
          "SELECT * FROM announcement_send($1, $2::jsonb, $3, $4, $5)",
          [event, JSON.stringify(draft), at, randomUUID(), randomUUID()],
        );
      const sent = (await send(null))[0]?.id ?? "";
      await f.fanOut();
      const center = () =>
        f.one<unknown[]>({ playerId: player }, "SELECT own_notifications(NULL, 20) AS r");
      const unread = () =>
        f.one<number>({ playerId: player }, "SELECT own_unread_notifications() AS r");
      const list = () =>
        f.one<{ id: string }[]>({ playerId: player }, "SELECT member_announcements($1, 20) AS r", [
          event,
        ]);
      expect(await center()).toHaveLength(1);
      expect(await report(player, { kind: "announcement", target: sent })).toBe("reported");
      await unpublish("announcement", sent);
      expect(await center()).toEqual([]);
      expect(await unread()).toBe(0);
      expect(await list()).toEqual([]);
      await republish("announcement", sent);
      expect((await list()).map((one) => one.id)).toEqual([sent]);

      const later = (await send(new Date(Date.now() + 5 * 60_000)))[0]?.id ?? "";
      await unpublish("announcement", later);
      await f.owner("ALTER TABLE announcement DISABLE TRIGGER announcement_frozen");
      await f.owner("UPDATE announcement SET send_at = now() - interval '1 minute' WHERE id = $1", [
        later,
      ]);
      await f.owner("ALTER TABLE announcement ENABLE TRIGGER announcement_frozen");
      await f.owner("SELECT push_due_announcement(100)");
      const [row] = await f.owner<{ status: string; skip_reason: string }>(
        "SELECT status, skip_reason FROM announcement WHERE id = $1",
        [later],
      );
      expect(row).toEqual({ status: "skipped", skip_reason: "held" });
    });
  });

  describe("a held item and the other doors", () => {
    it("copies neither a held reward nor a held quest into a duplicated event", async () => {
      const event = await live();
      const heldQuest = await quest(event, "Held quest");
      await quest(event, "Kept quest");
      const heldReward = await reward(event);
      await reward(event);
      await unpublish("quest", heldQuest);
      await unpublish("reward", heldReward);
      const [target] = await f.owner<{ id: string }>(
        `INSERT INTO event (organizer_id, join_code, name_en, starts_at, ends_at)
         SELECT organizer_id, 'HOLDCOPY', 'Copy', now() + interval '30 days', now() + interval '31 days'
         FROM event WHERE id = $1 RETURNING id`,
        [event],
      );
      await f.run({ ...f.team(), repeatableRead: true }, "SELECT event_copy_setup($1, $2, $3)", [
        event,
        target?.id,
        randomUUID(),
      ]);
      const titles = await f.owner<{ title_en: string }>(
        "SELECT title_en FROM quest WHERE event_id = $1",
        [target?.id],
      );
      expect(titles.map((row) => row.title_en)).toEqual(["Kept quest"]);
      expect(await f.count("reward WHERE event_id = $1", [target?.id])).toBe(1);
    });

    it("skips a queued push of a held announcement at the claim", async () => {
      const event = await live();
      const phone = await f.playerWithPhone();
      await f.join(event, phone.who);
      await f.drain();
      const [sent] = await f.run<{ id: string }>(
        f.team(),
        "SELECT * FROM announcement_send($1, $2::jsonb, NULL, $3, $4)",
        [
          event,
          JSON.stringify({
            titleAr: "تنبيه",
            titleEn: "Notice",
            bodyAr: "نص التنبيه هنا.",
            bodyEn: "The notice text here.",
            pushBodyAr: "نص التنبيه هنا.",
            pushBodyEn: "The notice text here.",
          }),
          randomUUID(),
          randomUUID(),
        ],
      );
      await f.fanOut();
      await unpublish("announcement", sent?.id ?? "");
      expect(await f.claim()).toEqual([]);
      const states = await f.owner<{ state: string; code: string | null }>(
        "SELECT state, code FROM push_send WHERE device_id = $1",
        [phone.deviceId],
      );
      expect(states.length).toBeGreaterThan(0);
      expect(states.every((row) => row.state === "skipped")).toBe(true);
    });
  });

  describe("erasure and retention", () => {
    it("deletes reports about an erased username and keeps an erased reporter's reports without them", async () => {
      const event = await live();
      const reporter = await member(event);
      const reported = await member(event);
      await report(reporter.player, {
        kind: "username",
        target: null,
        name: await f.usernameOf(reported.player),
      });
      await report(reporter.player, { kind: "event", target: event });
      expect(await f.erase(reported.player)).toBeDefined();
      expect(await f.count("content_report WHERE target_id = $1", [reported.player])).toBe(0);
      await f.erase(reporter.player);
      const [kept] = await reportsOf(event);
      expect(kept?.reporter_id).toBeNull();
    });

    it("drops the erased reporter's own words and mark from the reports it keeps", async () => {
      const event = await live();
      const reporter = await member(event);
      await report(reporter.player, { kind: "event", target: event, note: NOTE });
      await f.owner("UPDATE content_report SET marked = true WHERE target_id = $1", [event]);
      await f.erase(reporter.player);
      const kept = await f.owner<{ note: string | null; marked: boolean }>(
        "SELECT note, marked FROM content_report WHERE target_id = $1",
        [event],
      );
      expect(kept).toEqual([{ note: null, marked: false }]);
    });

    it("purges handled reports 180 days after handling and keeps open ones", async () => {
      const event = await live();
      const { player } = await member(event);
      await report(player, { kind: "event", target: event });
      await resolve("event", event, "dismissed");
      const old = await member(event);
      await report(old.player, { kind: "event", target: event });
      await f.owner(
        "UPDATE content_report SET handled_at = now() - interval '181 days' WHERE target_id = $1 AND status <> 'open'",
        [event],
      );
      const gone = await f.one<number>({}, "SELECT purge_handled_reports(1000) AS r");
      expect(gone).toBeGreaterThanOrEqual(1);
      expect((await reportsOf(event)).map((one) => one.status)).toEqual(["open"]);
    });
  });
});
