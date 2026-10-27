import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  NOON,
  invitationFixture,
  sqlstate,
  type Claimed,
  type InvitationFixture,
} from "#test/support/invitations";
import { TEST_DATABASE_URL } from "#test/support/test-db";

/** A moment given as Riyadh wall-clock time on an ordinary day. */
const riyadh = (time: string): Date => new Date(`2026-10-27T${time}+03:00`);

/**
 * Questify invitations in the database, from the claim to the purge (T-409, migration 0073; ADR-333): the claim's
 * system seat, re-checks and quiet hours, the acknowledgement and the channel hold, Finding 2's rule that no recipient
 * row is ever left stuck, settle (joins, finish, final, the daily publish, the purge), the landing page's open and
 * erasure.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("invitation sending (database)", () => {
  let f: InvitationFixture;
  beforeAll(async () => {
    f = await invitationFixture();
    await f.switchOn();
  });
  afterAll(async () => {
    await f.close();
  });
  beforeEach(async () => {
    await f.switchOn();
  });

  const lapse = (rows: readonly Pick<Claimed, "recipient_id">[]) =>
    f.owner(
      "UPDATE invitation_recipient SET lease_until = now() - interval '1 second' WHERE id = ANY ($1)",
      [rows.map((row) => row.recipient_id)],
    );
  const sendAll = async (count: number) => {
    const claimed = await f.claimAt(count);
    for (const one of claimed) await f.ack(one, "sent");
    return claimed;
  };

  const open = (link: string) =>
    f.one<Record<string, unknown> | null>(f.system, "SELECT invitation_open($1) AS r", [link]);

  describe("the claim", () => {
    it("runs in the system context only", async () => {
      await f.launch(50);
      for (const seat of [
        f.ownerSeat,
        f.adminSeat,
        { playerId: (await f.optedIn(1))[0] ?? "" },
        { deviceId: randomUUID() },
      ]) {
        expect(await sqlstate(f.run(seat, "SELECT * FROM invitation_claim('{sms}', 5)"))).toBe(
          "IV403",
        );
      }
    });

    it("leases at most 5 with fresh tokens, the contact and language read fresh and the copied names", async () => {
      const { campaign, players } = await f.launch(50, { language: "en" });
      const claimed = await f.claimAt(9);
      expect(claimed).toHaveLength(5);
      expect(new Set(claimed.map((row) => row.lease)).size).toBe(5);
      const row = await f.campaignRow(campaign);
      for (const one of claimed) {
        expect(players).toContain(one.player_id);
        expect(one).toMatchObject({
          channel: "sms",
          language: "en",
          name_ar: row.name_ar,
          name_en: row.name_en,
        });
        expect(one.phone).toMatch(/^\+9665[0-9]{8}$/);
      }
      expect(await f.statesOf(campaign)).toEqual({ queued: 45, sending: 5 });
      for (const leased of (await f.recipients(campaign)).filter((r) => r.state === "sending")) {
        expect(leased.sent_at).not.toBeNull();
        expect(leased.lease_token).not.toBeNull();
      }
      expect(await f.claimAt(0)).toEqual([]);
    });

    it("reads a consent with no language as Arabic", async () => {
      await f.launch(50, { language: null });
      expect((await f.claimAt(1))[0]?.language).toBe("ar");
    });

    it("leases disjoint rows to two servers: the second waits for the first's campaign lock", async () => {
      await f.launch(60);
      const [database] = await f.owner<{ name: string }>("SELECT current_database() AS name");
      const url = new URL(TEST_DATABASE_URL ?? "");
      url.pathname = `/${database?.name ?? ""}`;
      const first = new Client({ connectionString: url.toString() });
      const second = new Client({ connectionString: url.toString() });
      await first.connect();
      await second.connect();
      try {
        await first.query("BEGIN");
        const sql = "SELECT recipient_id FROM invitation_claim_at('{sms}', 5, $1)";
        const a = (await first.query<{ recipient_id: string }>(sql, [NOON])).rows;
        const pid = (await second.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]
          ?.pid;
        const pending = second.query<{ recipient_id: string }>(sql, [NOON]);
        let waited = false;
        for (let attempt = 0; attempt < 200 && !waited; attempt += 1) {
          waited =
            (
              await f.owner(
                "SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND wait_event_type = 'Lock'",
                [pid],
              )
            ).length === 1;
          if (!waited) await new Promise((resolve) => setTimeout(resolve, 10));
        }
        await first.query("COMMIT");
        const b = (await pending).rows;
        expect(waited).toBe(true);
        expect(a).toHaveLength(5);
        expect(b).toHaveLength(5);
        const ids = new Set([...a, ...b].map((row) => row.recipient_id));
        expect(ids.size).toBe(10);
      } finally {
        await first.end();
        await second.end();
      }
    });

    it("skips a player who opted out, lost the phone, was banned or joined the event since the fill", async () => {
      const { campaign, event, players } = await f.launch(50);
      const [optedOut, noPhone, banned, member] = players;
      await f.owner(
        "INSERT INTO marketing_consent (player_id, channel, granted, method) VALUES ($1, 'sms', false, 'opt_out_link')",
        [optedOut],
      );
      await f.owner(
        "UPDATE player_contact SET phone_e164 = NULL, email = 'x@mail.test' WHERE player_id = $1",
        [noPhone],
      );
      await f.owner("UPDATE player SET status = 'banned' WHERE id = $1", [banned]);
      await f.join(event, member ?? "");
      const leased = new Set<string>();
      for (let round = 0; round < 10; round += 1) {
        for (const row of await f.claimAt(5)) leased.add(row.player_id);
      }
      for (const who of [optedOut, noPhone, banned, member])
        expect(leased.has(who ?? "")).toBe(false);
      expect(leased.size).toBe(46);
      const skipped = (await f.recipients(campaign)).filter((row) => row.state === "skipped");
      expect(Object.fromEntries(skipped.map((row) => [row.player_id, row.skip_reason]))).toEqual({
        [optedOut ?? ""]: "opted_out",
        [noPhone ?? ""]: "opted_out",
        [banned ?? ""]: "opted_out",
        [member ?? ""]: "member",
      });
      expect((await f.campaignRow(campaign)).skipped).toBe(4);
    });

    it("skips the queued rows of a campaign whose event is over (event_over)", async () => {
      const { campaign, event } = await f.launch(50);
      await f.endEventIn(event, "-1 minute");
      expect(await f.claimAt(5)).toEqual([]);
      expect(await f.statesOf(campaign)).toEqual({ skipped: 50 });
      expect((await f.recipients(campaign)).every((row) => row.skip_reason === "event_over")).toBe(
        true,
      );
      expect((await f.campaignRow(campaign)).skipped).toBe(50);
    });

    it.each([
      ["made unlisted", "UPDATE event SET access = 'unlisted' WHERE id = $1"],
      ["made private", "UPDATE event SET access = 'private' WHERE id = $1"],
      ["made guest-list-only", "UPDATE event SET guest_list_only = true WHERE id = $1"],
      ["given a domain lock", "UPDATE event SET email_domains = '{acme.com}' WHERE id = $1"],
      ["with link joining off", "UPDATE event SET join_methods = '{code,qr}' WHERE id = $1"],
    ])("skips the rest of a campaign whose event was %s (event_changed)", async (_case, change) => {
      const { campaign, event } = await f.launch(50);
      expect(await f.claimAt(5)).toHaveLength(5);
      await f.owner(change, [event]);
      expect(await f.claimAt(5)).toEqual([]);
      expect(await f.statesOf(campaign)).toEqual({ sending: 5, skipped: 45 });
      expect(
        (await f.recipients(campaign))
          .filter((row) => row.state === "skipped")
          .every((row) => row.skip_reason === "event_changed"),
      ).toBe(true);
    });

    it.each([
      ["22:00:00", 0],
      ["23:30:00", 0],
      ["03:00:00", 0],
      ["08:59:00", 0],
      ["08:59:30", 0],
      ["21:59:30", 0],
      ["09:00:00", 5],
      ["21:58:59", 5],
    ])("at %s Riyadh time claims %i SMS whatever the API passed", async (time, expected) => {
      await f.launch(50);
      expect(await f.claimAt(5, riyadh(time))).toHaveLength(expected);
    });

    it("passes the database clock to the quiet band (the door is the fixed-moment claim at now())", async () => {
      const [definition] = await f.owner<{ body: string }>(
        "SELECT prosrc AS body FROM pg_proc WHERE proname = 'invitation_claim'",
      );
      expect(definition?.body.replace(/\s+/g, " ").trim()).toBe(
        "SELECT * FROM invitation_claim_at(allowed, size, now())",
      );
      const [quiet] = await f.owner<{ night: boolean; day: boolean; edge: boolean }>(
        `SELECT invitation_sms_quiet($1) AS night, invitation_sms_quiet($2) AS day, invitation_sms_quiet($3) AS edge`,
        [riyadh("22:00:00"), riyadh("09:00:00"), riyadh("08:59:59")],
      );
      expect(quiet).toEqual({ night: true, day: false, edge: true });
    });

    it("claims nothing while an SMS hold is open, and again once it has passed", async () => {
      await f.launch(50);
      await f.owner(
        "INSERT INTO invitation_channel_hold (channel, hold_until, code) VALUES ('sms', now() + interval '10 minutes', '1060')",
      );
      expect(await f.claimAt(5)).toEqual([]);
      await f.owner("UPDATE invitation_channel_hold SET hold_until = now() - interval '1 second'");
      expect(await f.claimAt(5)).toHaveLength(5);
    });

    it("claims nothing with the switch off, or for a channel other than SMS", async () => {
      await f.launch(50);
      expect(await f.claimAt(5, NOON, [])).toEqual([]);
      expect(await f.claimAt(5, NOON, ["push", "email"])).toEqual([]);
      await f.switchOn(false);
      expect(await f.claimAt(5)).toEqual([]);
    });
  });

  describe("the acknowledgement", () => {
    it.each([
      ["sent", "", { sent: 1, unknown: 0, failed: 0 }, null],
      ["unknown", "timeout", { sent: 0, unknown: 1, failed: 0 }, "timeout"],
      ["failed", "1120", { sent: 0, unknown: 0, failed: 1 }, "1120"],
    ])("records %s once, with its counter", async (outcome, code, counts, stored) => {
      const { campaign } = await f.launch(50);
      const [claimed] = await f.claimAt(1);
      if (claimed === undefined) throw new Error("nothing claimed");
      expect(await f.ack(claimed, outcome, code)).toBe("recorded");
      expect(await f.ack(claimed, outcome, code)).toBe("stale");
      expect(await f.campaignRow(campaign)).toMatchObject(counts);
      const [row] = (await f.recipients(campaign)).filter((r) => r.id === claimed.recipient_id);
      expect(row).toMatchObject({ state: outcome, error_code: stored, lease_token: null });
    });

    it("ignores an answer with another lease token", async () => {
      const { campaign } = await f.launch(50);
      const [claimed] = await f.claimAt(1);
      expect(
        await f.ack({ recipient_id: claimed?.recipient_id ?? "", lease: randomUUID() }, "sent"),
      ).toBe("stale");
      expect(await f.ack({ recipient_id: "9007199254740", lease: randomUUID() }, "sent")).toBe(
        "stale",
      );
      expect(await f.statesOf(campaign)).toEqual({ queued: 49, sending: 1 });
    });

    it("holds the channel on an account refusal and puts the message back without counting an attempt", async () => {
      const { campaign } = await f.launch(50);
      const [claimed] = await f.claimAt(1);
      if (claimed === undefined) throw new Error("nothing claimed");
      expect(await f.ack(claimed, "hold", "1060")).toBe("held");
      const [row] = (await f.recipients(campaign)).filter((r) => r.id === claimed.recipient_id);
      expect(row).toMatchObject({
        state: "queued",
        sent_at: null,
        lease_token: null,
        error_code: null,
      });
      expect(await f.campaignRow(campaign)).toMatchObject({
        sent: 0,
        unknown: 0,
        failed: 0,
        cancelled: 0,
      });
      const holds = await f.owner<{ channel: string; code: string; minutes: number }>(
        "SELECT channel, code, round(extract(epoch FROM hold_until - now()) / 60)::int AS minutes FROM invitation_channel_hold",
      );
      expect(holds).toEqual([{ channel: "sms", code: "1060", minutes: 15 }]);
      expect(await f.claimAt(5)).toEqual([]);
      const [audit] = await f.owner<{
        after: Record<string, unknown>;
        organizer_id: string | null;
      }>(
        "SELECT after, organizer_id FROM audit_log WHERE action = 'invitation.hold' ORDER BY id DESC LIMIT 1",
      );
      expect(audit).toEqual({ after: { channel: "sms", code: "1060" }, organizer_id: null });
    });

    it("refuses an unknown outcome and any seat but the system's", async () => {
      await f.launch(50);
      const [claimed] = await f.claimAt(1);
      await expect(
        f.ack(claimed ?? { recipient_id: "", lease: "" }, "maybe"),
      ).rejects.toMatchObject({
        code: "IV422",
        detail: "outcome",
      });
      const sql = "SELECT invitation_ack($1, $2, 'sent', NULL)";
      const values = [claimed?.recipient_id, claimed?.lease];
      for (const seat of [f.ownerSeat, f.adminSeat, { deviceId: randomUUID() }]) {
        expect(await sqlstate(f.run(seat, sql, values))).toBe("IV403");
      }
    });
  });

  describe("no row is left stuck (Finding 2)", () => {
    it("cancel mid-round, account refusal → row cancelled", async () => {
      const { campaign } = await f.launch(50);
      const claimed = await f.claimAt(5);
      await f.adminCancel(campaign);
      expect(await f.ack(claimed[0] ?? { recipient_id: "", lease: "" }, "hold", "1110")).toBe(
        "held",
      );
      expect(await f.statesOf(campaign)).toEqual({ cancelled: 46, sending: 4 });
      expect(await f.campaignRow(campaign)).toMatchObject({ state: "cancelled", cancelled: 46 });
    });

    it("cancel mid-round, ack sent → counted, still cancelled", async () => {
      const { campaign } = await f.launch(50);
      const claimed = await f.claimAt(5);
      await f.adminCancel(campaign);
      expect(await f.ack(claimed[0] ?? { recipient_id: "", lease: "" }, "sent")).toBe("recorded");
      expect(await f.campaignRow(campaign)).toMatchObject({
        state: "cancelled",
        sent: 1,
        cancelled: 45,
      });
    });

    it("leased, cancelled, lease expires → settle makes it unknown, with the token cleared", async () => {
      const { campaign } = await f.launch(50);
      const claimed = await f.claimAt(5);
      await f.adminCancel(campaign);
      await lapse(claimed);
      await f.switchOn(false);
      const summary = await f.settle();
      expect(summary).toMatchObject({ expired: 5 });
      expect(await f.statesOf(campaign)).toEqual({ cancelled: 45, unknown: 5 });
      expect((await f.recipients(campaign)).every((row) => row.lease_token === null)).toBe(true);
      expect(await f.campaignRow(campaign)).toMatchObject({
        state: "cancelled",
        unknown: 5,
        cancelled: 45,
      });
    });

    it("expire, then ack sent → row stays unknown, counters unchanged", async () => {
      const { campaign } = await f.launch(50);
      const claimed = await f.claimAt(1);
      await lapse(claimed);
      await f.settle();
      expect(await f.ack(claimed[0] ?? { recipient_id: "", lease: "" }, "sent")).toBe("stale");
      const [row] = (await f.recipients(campaign)).filter((r) => r.id === claimed[0]?.recipient_id);
      expect(row?.state).toBe("unknown");
      expect(await f.campaignRow(campaign)).toMatchObject({ sent: 0, unknown: 1 });
      // An unknown row is never sent again.
      const later = await f.claimAt(5);
      expect(later.map((one) => one.recipient_id)).not.toContain(claimed[0]?.recipient_id);
    });

    it("the claim expires stale leases too, in any campaign state", async () => {
      const first = await f.launch(50);
      const claimed = await f.claimAt(2);
      await f.adminCancel(first.campaign);
      await lapse(claimed);
      expect(await f.claimAt(1)).toEqual([]);
      expect(await f.statesOf(first.campaign)).toEqual({ cancelled: 48, unknown: 2 });
    });

    it("each state's cancel sets finished_at; no queued row after an admin cancel of a sending campaign", async () => {
      const { campaign } = await f.launch(50);
      await f.claimAt(5);
      await f.adminCancel(campaign);
      const row = await f.campaignRow(campaign);
      expect(row.finished_at).not.toBeNull();
      expect(row.final_at).toBeNull();
      expect((await f.statesOf(campaign))["queued"]).toBeUndefined();
      await expect(f.adminCancel(campaign)).rejects.toMatchObject({ detail: "wrong_state" });
      const owned = await f
        .one<unknown>(f.ownerSeat, "SELECT invitation_cancel($1, $2, $3) AS r", [
          row.event_id,
          campaign,
          randomUUID(),
        ])
        .catch((error: { detail?: string }) => error.detail);
      expect(owned).toBe("wrong_state");
    });

    it("cancelled campaign's cancelled and unknown rows purged after 90 days, counters kept", async () => {
      const { campaign } = await f.launch(50);
      const claimed = await f.claimAt(5);
      await f.adminCancel(campaign);
      await lapse(claimed);
      await f.settle();
      await f.owner(
        "UPDATE invitation_campaign SET finished_at = now() - interval '91 days' WHERE id = $1",
        [campaign],
      );
      const summary = await f.settle();
      expect(summary).toMatchObject({ final: 1, purged: 50 });
      expect(await f.recipients(campaign)).toEqual([]);
      const row = await f.campaignRow(campaign);
      expect(row).toMatchObject({
        state: "cancelled",
        planned: 50,
        unknown: 5,
        cancelled: 45,
        published_sent: 5,
      });
      expect(row.final_at).not.toBeNull();
    });

    it("finish after the last ack and after the last expiry", async () => {
      const acked = await f.launch(50);
      await f.owner(
        `UPDATE invitation_recipient SET state = 'sent', sent_at = now()
         WHERE id IN (SELECT id FROM invitation_recipient WHERE campaign_id = $1 ORDER BY id LIMIT 49)`,
        [acked.campaign],
      );
      const [last] = await f.claimAt(1);
      await f.settle();
      expect((await f.campaignRow(acked.campaign)).state).toBe("sending");
      await f.ack(last ?? { recipient_id: "", lease: "" }, "sent");
      await f.settle();
      const done = await f.campaignRow(acked.campaign);
      expect(done).toMatchObject({ state: "sent", end_reason: null, final_at: null });
      expect(done.finished_at).not.toBeNull();

      const expired = await f.launch(50);
      await f.owner(
        `UPDATE invitation_recipient SET state = 'failed', sent_at = now()
         WHERE id IN (SELECT id FROM invitation_recipient WHERE campaign_id = $1 ORDER BY id LIMIT 49)`,
        [expired.campaign],
      );
      await lapse(await f.claimAt(1));
      await f.settle();
      expect(await f.campaignRow(expired.campaign)).toMatchObject({ state: "sent", unknown: 1 });
    });

    it.each(["the switch off", "a channel hold open", "no promotional sender (no channel passed)"])(
      "with %s, event ends, settle → sent with event_over, rows skipped, purged after 90 days",
      async (blocker) => {
        const { campaign, event } = await f.launch(50);
        if (blocker === "the switch off") await f.switchOn(false);
        if (blocker === "a channel hold open") {
          await f.owner(
            "INSERT INTO invitation_channel_hold (channel, hold_until, code) VALUES ('sms', now() + interval '1 day', '1060')",
          );
        }
        const allowed = blocker.startsWith("no promotional") ? [] : ["sms"];
        expect(await f.claimAt(5, NOON, allowed)).toEqual([]);
        await f.endEventIn(event, "-1 minute");
        await f.switchOn(false);
        await f.settle();
        expect(await f.statesOf(campaign)).toEqual({ skipped: 50 });
        const row = await f.campaignRow(campaign);
        expect(row).toMatchObject({
          state: "sent",
          end_reason: "event_over",
          skipped: 50,
          published_sent: 0,
        });
        expect(row.finished_at).not.toBeNull();
        expect(row.final_at).not.toBeNull();
        await f.owner(
          "UPDATE invitation_campaign SET finished_at = now() - interval '91 days' WHERE id = $1",
          [campaign],
        );
        await f.settle();
        expect(await f.recipients(campaign)).toEqual([]);
        expect((await f.campaignRow(campaign)).skipped).toBe(50);
      },
    );

    it("switch off from approval to the event's end → cancelled event_over", async () => {
      await f.reset();
      await f.optedIn(50);
      const event = await f.eligibleEvent();
      const made = await f.request(event);
      await f.approve(made.id);
      await f.switchOn(false);
      expect(await f.startDue()).toBe("off");
      await f.endEventIn(event, "-1 minute");
      expect(await f.settle()).toMatchObject({ cancelled: 1 });
      const row = await f.campaignRow(made.id);
      expect(row).toMatchObject({ state: "cancelled", end_reason: "event_over" });
      expect(row.finished_at).not.toBeNull();
      expect(row.final_at).not.toBeNull();
    });
  });

  describe("settle", () => {
    it("counts a join once, only after the message and not while pending or rehearsing", async () => {
      const { campaign, event } = await f.launch(50);
      const [after, before, pending, rehearsal] = await sendAll(4);
      await f.join(event, after?.player_id ?? "");
      const early = await f.join(event, before?.player_id ?? "");
      await f.owner(
        "UPDATE enrollment SET joined_at = (SELECT sent_at - interval '1 minute' FROM invitation_recipient WHERE id = $2) WHERE id = $1",
        [early, before?.recipient_id],
      );
      const waiting = await f.join(event, pending?.player_id ?? "");
      await f.owner("UPDATE enrollment SET status = 'pending' WHERE id = $1", [waiting]);
      await f.join(event, rehearsal?.player_id ?? "", "rehearsal");
      expect(await f.settle()).toMatchObject({ joined: 1 });
      expect(await f.settle()).toMatchObject({ joined: 0 });
      await f.owner("UPDATE enrollment SET status = 'active' WHERE id = $1", [waiting]);
      await f.settle();
      expect((await f.campaignRow(campaign)).joined).toBe(2);
      const joined = (await f.recipients(campaign)).filter((row) => row.joined_at !== null);
      expect(joined.map((row) => row.player_id).toSorted()).toEqual(
        [after?.player_id, pending?.player_id].toSorted(),
      );
    });

    it("publishes the organizer's numbers once a Questify day after the start day, never on the start day", async () => {
      const { campaign } = await f.launch(50);
      await sendAll(3);
      await f.settle();
      expect((await f.campaignRow(campaign)).published_at).toBeNull();
      await f.owner(
        "UPDATE invitation_campaign SET started_at = now() - interval '1 day' WHERE id = $1",
        [campaign],
      );
      await f.settle();
      const first = await f.campaignRow(campaign);
      expect(first).toMatchObject({ published_sent: 3, published_opened: 0, published_joined: 0 });
      await sendAll(2);
      await f.settle();
      expect((await f.campaignRow(campaign)).published_sent).toBe(3);
      await f.owner(
        "UPDATE invitation_campaign SET published_at = now() - interval '1 day' WHERE id = $1",
        [campaign],
      );
      await f.settle();
      expect((await f.campaignRow(campaign)).published_sent).toBe(5);
    });

    it("closes the results when the event ends, or 30 days after the campaign finished, and publishes them", async () => {
      const { campaign, event } = await f.launch(50);
      await sendAll(5);
      await f.adminCancel(campaign);
      await f.settle();
      expect((await f.campaignRow(campaign)).final_at).toBeNull();
      await f.owner(
        "UPDATE invitation_campaign SET finished_at = now() - interval '31 days' WHERE id = $1",
        [campaign],
      );
      await f.settle();
      expect(await f.campaignRow(campaign)).toMatchObject({ published_sent: 5 });
      expect((await f.campaignRow(campaign)).final_at).not.toBeNull();

      const second = await f.launch(50);
      await sendAll(1);
      await f.adminCancel(second.campaign);
      await f.endEventIn(second.event, "-1 minute");
      expect(await f.settle()).toMatchObject({ final: 1 });
      expect(event).not.toBe(second.event);
    });

    it("runs in the system context only, and with the switch off", async () => {
      await f.switchOn(false);
      expect(await f.settle()).toMatchObject({ more: false });
      for (const seat of [f.ownerSeat, f.adminSeat]) {
        expect(await sqlstate(f.run(seat, "SELECT invitation_settle()"))).toBe("IV403");
      }
    });
  });

  describe("the landing page's open", () => {
    it("counts the first open of a sent message once and answers the public event card only", async () => {
      const { campaign, event } = await f.launch(50);
      const [claimed] = await f.claimAt(1);
      await f.ack(claimed ?? { recipient_id: "", lease: "" }, "sent");
      const card = await open(claimed?.link ?? "");
      expect(Object.keys(card ?? {}).toSorted()).toEqual(
        [
          "endsAt",
          "id",
          "joinCode",
          "kind",
          "name",
          "startsAt",
          "statusNow",
          "timezone",
          "venue",
        ].toSorted(),
      );
      expect(card).toMatchObject({ id: event, statusNow: "scheduled" });
      await open(claimed?.link ?? "");
      expect((await f.campaignRow(campaign)).opened).toBe(1);
      const [row] = (await f.recipients(campaign)).filter((r) => r.id === claimed?.recipient_id);
      expect(row?.opened_at).not.toBeNull();
    });

    it("answers a queued row's link without counting it, and null for an unknown link or an event that is over", async () => {
      const { campaign, event } = await f.launch(50);
      const [queued] = await f.recipients(campaign);
      expect(await open(queued?.link ?? "")).not.toBeNull();
      expect((await f.campaignRow(campaign)).opened).toBe(0);
      expect(await open(randomUUID())).toBeNull();
      await f.endEventIn(event, "-1 minute");
      expect(await open(queued?.link ?? "")).toBeNull();
    });

    it("answers null for a purged link", async () => {
      const { campaign } = await f.launch(50);
      const [claimed] = await f.claimAt(1);
      await f.ack(claimed ?? { recipient_id: "", lease: "" }, "sent");
      await f.adminCancel(campaign);
      await f.owner(
        "UPDATE invitation_campaign SET final_at = now(), finished_at = now() - interval '91 days' WHERE id = $1",
        [campaign],
      );
      await f.settle();
      expect(await open(claimed?.link ?? "")).toBeNull();
    });
  });

  describe("a campaign's rows go with it", () => {
    it("deletes every recipient row of a deleted campaign (an admin deleting its event), and no other", async () => {
      const { campaign, event } = await f.launch(50);
      await f.claimAt(2);
      const other = await f.eligibleEvent();
      const kept = await f.request(other);
      await f.owner(
        "INSERT INTO invitation_recipient (campaign_id, player_id, channel) SELECT $1, player_id, 'sms' FROM invitation_recipient WHERE campaign_id = $2 LIMIT 3",
        [kept.id, campaign],
      );
      await f.owner("DELETE FROM event WHERE id = $1", [event]);
      expect(await f.owner("SELECT 1 FROM invitation_campaign WHERE id = $1", [campaign])).toEqual(
        [],
      );
      expect(await f.recipients(campaign)).toEqual([]);
      expect(await f.recipients(kept.id)).toHaveLength(3);
    });
  });

  describe("erasure", () => {
    it("deletes the player's recipient rows at once and keeps the campaign's counters", async () => {
      const { campaign } = await f.launch(50);
      const [claimed] = await f.claimAt(1);
      await f.ack(claimed ?? { recipient_id: "", lease: "" }, "sent");
      const who = claimed?.player_id ?? "";
      const token = await f.deletionToken(who);
      const [erased] = await f.run<{ outcome: string }>(
        { playerId: who },
        "SELECT outcome FROM erase_player($1, true, $2)",
        [token, randomUUID()],
      );
      expect(erased?.outcome).toBe("erased");
      expect(
        await f.owner("SELECT 1 FROM invitation_recipient WHERE player_id = $1", [who]),
      ).toEqual([]);
      expect(await f.campaignRow(campaign)).toMatchObject({ planned: 50, sent: 1 });
    });
  });
});
