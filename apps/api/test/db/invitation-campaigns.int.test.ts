import { randomUUID } from "node:crypto";
import { invitationCampaignsSchema } from "@questify/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { invitationUrl, renderInvitation } from "#src/invitation-campaigns/message";
import { invitationFixture, sqlstate, type InvitationFixture } from "#test/support/invitations";
import { addMember, TEST_DATABASE_URL } from "#test/support/test-db";

type Org = { id: string; state: string; endReason: string | null; counts: Record<string, unknown> };

/**
 * Questify invitations in the database, the campaign's life up to its start (T-409, migration 0073; FR-738 to FR-740):
 * the owner's request and every refusal, the admin's approval with the frozen names (Finding 1), refusal and cancel,
 * the fill through promo_pool with every criterion and limit, the organizer's rounded answers and audit rows without
 * counts. Sending, settle and Finding 2 are in invitation-sending.int.test.ts.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("invitation campaigns (database)", () => {
  let f: InvitationFixture;
  beforeAll(async () => {
    f = await invitationFixture();
    await f.switchOn();
  });
  afterAll(async () => {
    await f.close();
  });

  const listOf = async (event: string, seat = f.ownerSeat) =>
    f.one<{ enabled: boolean; campaigns: Org[] }>(seat, "SELECT invitation_list($1) AS r", [event]);

  const startWith = async (over: Record<string, unknown> = {}, cap = 1000, event?: string) => {
    const target = event ?? (await f.eligibleEvent());
    const made = await f.request(target, over);
    await f.approve(made.id, { cap });
    return { event: target, campaign: made.id, outcome: await f.startDue() };
  };
  const invited = async (campaign: string) =>
    (await f.recipients(campaign)).map((row) => row.player_id).toSorted();
  const detail = (campaign: string) =>
    f.one<{
      names: { ar: string | null; en: string | null };
      estimate: number | null;
      eventIssue: string | null;
    }>(f.adminSeat, "SELECT invitation_admin_get($1) AS r", [campaign]);

  describe("the owner's request", () => {
    it("records a requested campaign with its criteria, for the owner only", async () => {
      const event = await f.eligibleEvent();
      const made = await f.request<Org & { interests: string[]; history: string; size: number }>(
        event,
        { cityId: "sa-jeddah", interests: ["tech", "sport"], history: "recent", size: 120 },
      );
      expect(made).toMatchObject({
        state: "requested",
        interests: ["sport", "tech"],
        history: "recent",
        size: 120,
        counts: { sent: null, opened: null, joined: null },
      });
      const scoped = await addMember(f.db.owner, f.ids.orgA, "editor", [f.ids.eventA]);
      expect(await sqlstate(f.request(event, {}, f.team(f.editor)))).toBe("IV403");
      expect(await sqlstate(f.request(event, {}, f.team(scoped)))).toBe("IV404");
      expect(await sqlstate(f.request(event, {}, f.team(f.ownerB, f.ids.orgB)))).toBe("IV404");
      expect(await sqlstate(f.request(event, {}, f.adminSeat))).toBe("IV404");
      expect(await sqlstate(f.request(event, {}, f.system))).toBe("IV404");
    });

    it("tells the editor owner_only and the stranger nothing", async () => {
      const event = await f.eligibleEvent();
      await expect(f.request(event, {}, f.team(f.editor))).rejects.toMatchObject({
        code: "IV403",
        detail: "owner_only",
      });
    });

    it.each([
      ["unlisted", "UPDATE event SET access = 'unlisted' WHERE id = $1", "not_public"],
      ["private", "UPDATE event SET access = 'private' WHERE id = $1", "not_public"],
      [
        "ended",
        "UPDATE event SET starts_at = now() - interval '2 days', ends_at = now() - interval '1 hour' WHERE id = $1",
        "not_running",
      ],
      [
        "ending within 24 hours",
        "UPDATE event SET starts_at = now() + interval '1 hour', ends_at = now() + interval '23 hours' WHERE id = $1",
        "ends_soon",
      ],
      ["link joining off", "UPDATE event SET join_methods = '{code,qr}' WHERE id = $1", "link_off"],
      [
        "guest-list-only",
        "UPDATE event SET guest_list_only = true WHERE id = $1",
        "guest_list_only",
      ],
      [
        "domain-locked",
        "UPDATE event SET email_domains = '{acme.com}' WHERE id = $1",
        "email_domains",
      ],
    ])("refuses a %s event as not eligible", async (_case, change, reason) => {
      const event = await f.eligibleEvent();
      await f.owner(change, [event]);
      await expect(f.request(event)).rejects.toMatchObject({
        code: "IV409",
        detail: "event_not_eligible",
        hint: reason,
      });
    });

    it("refuses a draft event", async () => {
      const event = await f.eligibleEvent();
      await f.owner("UPDATE event SET status = 'draft' WHERE id = $1", [event]);
      await expect(f.request(event)).rejects.toMatchObject({ hint: "not_running" });
    });

    it.each([
      [{ size: 49 }, "size"],
      [{ size: 100_001 }, "size"],
      [{ size: 50.5 }, "size"],
      [{ size: "50" }, "size"],
      [{ cityId: "sa-nowhere" }, "cityId"],
      [{ cityId: 7 }, "cityId"],
      [{ interests: ["sport", "tech", "music", "art"] }, "interests"],
      [{ interests: ["knitting"] }, "interests"],
      [{ interests: ["sport", "sport"] }, "interests"],
      [{ interests: "sport" }, "interests"],
      [{ history: "ever" }, "history"],
      [{ sendAfter: "soon" }, "sendAfter"],
      [{ sendAfter: "2099-01-01T00:00:00Z" }, "sendAfter"],
      [{ playerIds: [] }, "body"],
    ])("refuses the criteria %j (IV422 %s)", async (over, field) => {
      const event = await f.eligibleEvent();
      await expect(f.request(event, over)).rejects.toMatchObject({ code: "IV422", detail: field });
    });

    it("keeps one open campaign per event", async () => {
      const event = await f.eligibleEvent();
      await f.request(event);
      await expect(f.request(event)).rejects.toMatchObject({
        code: "IV409",
        detail: "invitation_open",
      });
    });

    it("replays the same request key and refuses it with another body", async () => {
      const event = await f.eligibleEvent();
      const key = randomUUID();
      const first = await f.request(event, { size: 70 }, f.ownerSeat, key);
      const again = await f.request(event, { size: 70 }, f.ownerSeat, key);
      expect(again).toEqual(first);
      await expect(f.request(event, { size: 71 }, f.ownerSeat, key)).rejects.toMatchObject({
        code: "IV409",
        detail: "idempotency_mismatch",
      });
      const other = await f.eligibleEvent();
      await expect(f.request(other, { size: 70 }, f.ownerSeat, key)).rejects.toMatchObject({
        detail: "idempotency_mismatch",
      });
      expect(
        await f.owner("SELECT 1 FROM invitation_campaign WHERE event_id = $1", [event]),
      ).toHaveLength(1);
    });

    it("is refused while the platform switch is off, and lists `enabled: false`", async () => {
      const event = await f.eligibleEvent();
      await f.switchOn(false);
      try {
        await expect(f.request(event)).rejects.toMatchObject({
          code: "IV403",
          detail: "feature_off",
        });
        expect((await listOf(event)).enabled).toBe(false);
      } finally {
        await f.switchOn();
      }
      expect((await listOf(event)).enabled).toBe(true);
    });

    it("lets the owner withdraw it before it starts, final at once, and not after", async () => {
      const event = await f.eligibleEvent();
      const made = await f.request(event);
      const cancel = (campaign: string, seat = f.ownerSeat) =>
        f.one<Org>(seat, "SELECT invitation_cancel($1, $2, $3) AS r", [
          event,
          campaign,
          randomUUID(),
        ]);
      expect(await sqlstate(cancel(made.id, f.team(f.editor)))).toBe("IV403");
      expect(await sqlstate(cancel(randomUUID()))).toBe("IV404");
      expect((await cancel(made.id)).state).toBe("cancelled");
      const row = await f.campaignRow(made.id);
      expect(row).toMatchObject({ end_reason: "owner" });
      expect(row.finished_at).not.toBeNull();
      expect(row.final_at).not.toBeNull();
      await expect(cancel(made.id)).rejects.toMatchObject({ detail: "wrong_state" });
    });
  });

  describe("the admin's approval (Finding 1 (a))", () => {
    it("preview, rename, approve → 409: the names the console showed must still be the event's", async () => {
      const event = await f.eligibleEvent();
      const made = await f.request(event);
      const shown = (await detail(made.id)).names;
      await f.run(f.team(f.editor), "UPDATE event SET name_ar = 'اسم جديد' WHERE id = $1", [event]);
      await expect(
        f.approve(made.id, { names: { name_ar: shown.ar, name_en: shown.en } }),
      ).rejects.toMatchObject({ code: "IV409", detail: "event_renamed" });
      expect(await f.campaignRow(made.id)).toMatchObject({
        state: "requested",
        name_ar: null,
        name_en: null,
      });
      const fresh = (await detail(made.id)).names;
      expect(fresh.ar).toBe("اسم جديد");
      await f.approve(made.id, { names: { name_ar: fresh.ar, name_en: fresh.en } });
      expect(await f.campaignRow(made.id)).toMatchObject({
        state: "approved",
        name_ar: "اسم جديد",
        name_en: fresh.en,
      });
    });

    it("rename after approval sends the approved text, and never cancels the campaign", async () => {
      await f.reset();
      await f.optedIn(50, { language: "en" });
      const event = await f.eligibleEvent();
      const approvedNames = await f.eventNames(event);
      const made = await f.request(event);
      await f.approve(made.id);
      await f.owner(
        "UPDATE event SET name_ar = 'visit pay-now.co', name_en = 'Call 0501234567' WHERE id = $1",
        [event],
      );
      expect(await f.startDue()).toBe("started");
      const [claimed] = await f.claimAt(1);
      expect(claimed).toMatchObject({
        name_ar: approvedNames.name_ar,
        name_en: approvedNames.name_en,
      });
      const text = renderInvitation({
        language: "en",
        names: { ar: claimed?.name_ar ?? null, en: claimed?.name_en ?? null },
        link: invitationUrl("en", "X".repeat(22)),
        optOut: "https://questify.sa/en/opt-out?t=x",
      });
      expect(text.startsWith(`Invitation to ${approvedNames.name_en}: `)).toBe(true);
      expect(text).not.toContain("0501234567");
    });

    it.each([
      [{ cap: 49 }, "cap"],
      [{ cap: 100_001 }, "cap"],
      [{ channels: ["email"] }, "channels"],
      [{ channels: ["push", "email"] }, "channels"],
      [{ channels: ["push", null] }, "channels"],
      [{ channels: [] }, "channels"],
      [{ at: new Date(Date.now() - 5 * 60_000) }, "sendAt"],
      [{ at: new Date(Date.now() + 3 * 24 * 3600_000) }, "sendAt"],
      [{ note: "x".repeat(501) }, "note"],
    ])("refuses the approval %j (IV422 %s)", async (over, field) => {
      const made = await f.request(await f.eligibleEvent());
      await expect(f.approve(made.id, over)).rejects.toMatchObject({
        code: "IV422",
        detail: field,
      });
    });

    it("refuses an event that no longer qualifies, with the reason", async () => {
      const event = await f.eligibleEvent();
      const made = await f.request(event);
      await f.owner("UPDATE event SET access = 'unlisted' WHERE id = $1", [event]);
      await expect(f.approve(made.id)).rejects.toMatchObject({
        code: "IV422",
        detail: "event_not_eligible",
        hint: "not_public",
      });
    });

    it("is for an active platform admin only, and approves once", async () => {
      const made = await f.request(await f.eligibleEvent());
      const names = await f.eventNames((await f.campaignRow(made.id)).event_id);
      const sql = "SELECT invitation_approve($1, '{sms}', 100, now(), NULL, $2, $3, $4) AS r";
      const values = [made.id, names.name_ar, names.name_en, randomUUID()];
      for (const seat of [f.ownerSeat, f.system, { isAdmin: true, staffUserId: f.editor }]) {
        expect(await sqlstate(f.run(seat, sql, values))).toBe("QY403");
      }
      expect((await f.approve(made.id)).state).toBe("approved");
      await expect(f.approve(made.id)).rejects.toMatchObject({ detail: "wrong_state" });
    });

    it("refuses with a note the owner reads, from requested only", async () => {
      const event = await f.eligibleEvent();
      const made = await f.request(event);
      const refuse = (note: string | null) =>
        f.one<{ state: string }>(f.adminSeat, "SELECT invitation_refuse($1, $2, $3) AS r", [
          made.id,
          note,
          randomUUID(),
        ]);
      await expect(refuse(null)).rejects.toMatchObject({ code: "IV422", detail: "note" });
      await expect(refuse("   ")).rejects.toMatchObject({ detail: "note" });
      expect((await refuse("Not this month")).state).toBe("refused");
      const [listed] = (await listOf(event)).campaigns;
      expect(listed).toMatchObject({ state: "refused", note: "Not this month" });
      await expect(refuse("again")).rejects.toMatchObject({ detail: "wrong_state" });
      // A refused campaign is closed: the event may ask again.
      await f.request(event);
    });

    it("each state's cancel sets finished_at; a campaign that never started is final at once", async () => {
      for (const reach of ["requested", "approved"] as const) {
        const made = await f.request(await f.eligibleEvent());
        if (reach === "approved") await f.approve(made.id, { at: new Date(Date.now() + 3600_000) });
        expect((await f.adminCancel(made.id)).state).toBe("cancelled");
        const row = await f.campaignRow(made.id);
        expect(row.end_reason).toBe("admin");
        expect(row.finished_at).not.toBeNull();
        expect(row.final_at).not.toBeNull();
        await expect(f.adminCancel(made.id)).rejects.toMatchObject({ detail: "wrong_state" });
      }
    });
  });

  describe("the fill (invitation_start_due)", () => {
    beforeEach(async () => {
      await f.reset();
    });

    it("takes only active adults opted in to SMS now, with a phone", async () => {
      const good = await f.optedIn(50);
      const [minor] = await f.optedIn(1, { age: 18 });
      const [noPhone] = await f.optedIn(1, { phone: false });
      const [banned, deleted, outAgain] = await f.optedIn(3);
      await f.owner("UPDATE player SET status = 'banned' WHERE id = $1", [banned]);
      await f.owner("UPDATE player SET status = 'deleted', username = NULL WHERE id = $1", [
        deleted,
      ]);
      await f.owner(
        "INSERT INTO marketing_consent (player_id, channel, granted, method) VALUES ($1, 'sms', false, 'settings')",
        [outAgain],
      );
      const pushOnly = await f.optedIn(1);
      await f.owner(
        "INSERT INTO marketing_consent (player_id, channel, granted, method) VALUES ($1, 'sms', false, 'settings')",
        [pushOnly[0]],
      );
      const { campaign, outcome } = await startWith();
      expect(outcome).toBe("started");
      expect(await invited(campaign)).toEqual(good.toSorted());
      for (const left of [minor, noPhone, banned, deleted, outAgain]) {
        expect(await invited(campaign)).not.toContain(left);
      }
      expect(await f.campaignRow(campaign)).toMatchObject({ state: "sending", planned: 50 });
    });

    it("applies the city and any of the interests", async () => {
      const match = await f.optedIn(50, { cityId: "sa-jeddah", interests: ["tech", "food"] });
      await f.optedIn(5, { cityId: "sa-riyadh", interests: ["tech"] });
      await f.optedIn(5, { cityId: "sa-jeddah", interests: ["art"] });
      await f.optedIn(5);
      const { campaign } = await startWith({ cityId: "sa-jeddah", interests: ["sport", "tech"] });
      expect(await invited(campaign)).toEqual(match.toSorted());
    });

    it("applies `recent` (joined any event in the last 365 days) and `own` (another event of this organizer)", async () => {
      const recent = await f.optedIn(50);
      const stale = await f.optedIn(3);
      const pendingOnly = await f.optedIn(2);
      const elsewhere = await f.eligibleEvent(f.ids.orgB);
      for (const who of recent) await f.join(elsewhere, who);
      for (const who of stale) {
        const enrollment = await f.join(elsewhere, who);
        await f.owner(
          "UPDATE enrollment SET joined_at = now() - interval '400 days' WHERE id = $1",
          [enrollment],
        );
      }
      for (const who of pendingOnly) {
        const enrollment = await f.join(elsewhere, who);
        await f.owner("UPDATE enrollment SET status = 'pending' WHERE id = $1", [enrollment]);
      }
      const first = await startWith({ history: "recent" });
      expect(await invited(first.campaign)).toEqual(recent.toSorted());

      await f.isolate();
      const own = await f.optedIn(50);
      const theirs = await f.optedIn(4);
      const past = await f.eligibleEvent();
      for (const who of own) await f.join(past, who);
      for (const who of theirs) await f.join(elsewhere, who);
      const second = await startWith({ history: "own" });
      expect(await invited(second.campaign)).toEqual(own.toSorted());
    });

    it("never invites anyone with an enrollment in the event, in any status", async () => {
      const event = await f.eligibleEvent();
      const fresh = await f.optedIn(50);
      const members = await f.optedIn(3);
      for (const [index, who] of members.entries()) {
        const enrollment = await f.join(event, who);
        const status = ["pending", "left", "removed"][index];
        await f.owner("UPDATE enrollment SET status = $2 WHERE id = $1", [enrollment, status]);
      }
      const { campaign } = await startWith({}, 1000, event);
      expect(await invited(campaign)).toEqual(fresh.toSorted());
    });

    it("keeps at most one invitation a player per 7 days, and never twice for one event", async () => {
      const players = await f.optedIn(50);
      const first = await startWith();
      expect(first.outcome).toBe("started");
      // Queued rows always count.
      expect((await startWith()).outcome).toBe("too_small");
      // A sent row counts while under 7 days old; an older sent or unknown one does not, a failed one never does.
      await f.owner(
        "UPDATE invitation_recipient SET state = 'sent', sent_at = now() - interval '6 days' WHERE campaign_id = $1",
        [first.campaign],
      );
      expect((await startWith()).outcome).toBe("too_small");
      await f.owner(
        `UPDATE invitation_recipient SET state = CASE WHEN player_id = ANY ($2) THEN 'unknown' ELSE 'sent' END,
                                         sent_at = now() - interval '8 days' WHERE campaign_id = $1`,
        [first.campaign, players.slice(0, 10)],
      );
      const third = await startWith();
      expect(await invited(third.campaign)).toEqual(players.toSorted());
      // The same event never invites a player twice: with the 7-day limit out of the way (the third campaign's rows
      // failed, the first's sent a month ago), a new campaign for the first event finds no one, another event all.
      await f.owner("UPDATE invitation_recipient SET state = 'failed' WHERE campaign_id = $1", [
        third.campaign,
      ]);
      await f.owner(
        "UPDATE invitation_campaign SET state = 'sent', finished_at = now() WHERE id = ANY ($1)",
        [[first.campaign, third.campaign]],
      );
      await f.owner(
        "UPDATE invitation_recipient SET sent_at = now() - interval '30 days' WHERE campaign_id = $1",
        [first.campaign],
      );
      expect((await startWith({}, 1000, first.event)).outcome).toBe("too_small");
      expect((await startWith()).outcome).toBe("started");
    });

    it("stops at the cap, in the campaign's own fixed draw order", async () => {
      const players = await f.optedIn(80);
      const { campaign } = await startWith({}, 60);
      const rows = await f.recipients(campaign);
      expect(rows).toHaveLength(60);
      const [expected] = await f.owner<{ ids: string[] }>(
        `SELECT array_agg(p ORDER BY md5($1::text || p::text)) AS ids
         FROM unnest($2::uuid[]) p`,
        [campaign, players],
      );
      expect(rows.map((row) => row.player_id).toSorted()).toEqual(
        expected?.ids.slice(0, 60).toSorted(),
      );
      expect((await f.campaignRow(campaign)).planned).toBe(60);
    });

    it("cancels a fill under 50 players as too_small, leaving no row", async () => {
      await f.optedIn(49);
      const { campaign, outcome } = await startWith();
      expect(outcome).toBe("too_small");
      expect(await f.recipients(campaign)).toEqual([]);
      const row = await f.campaignRow(campaign);
      expect(row).toMatchObject({ state: "cancelled", end_reason: "too_small" });
      expect(row.final_at).not.toBeNull();
    });

    it("cancels a campaign whose event stopped qualifying before the start (event_changed)", async () => {
      await f.optedIn(50);
      const event = await f.eligibleEvent();
      const made = await f.request(event);
      await f.approve(made.id);
      await f.owner("UPDATE event SET access = 'private' WHERE id = $1", [event]);
      expect(await f.startDue()).toBe("event_changed");
      expect(await f.campaignRow(made.id)).toMatchObject({
        state: "cancelled",
        end_reason: "event_changed",
      });
    });

    it("starts a campaign whose event now ends within 24 hours (the approval bounded its send time)", async () => {
      await f.optedIn(50);
      const event = await f.eligibleEvent();
      const made = await f.request(event);
      await f.approve(made.id);
      await f.endEventIn(event, "5 hours");
      expect(await f.startDue()).toBe("started");
    });

    it("waits for its send time, and starts nothing while the switch is off", async () => {
      await f.optedIn(50);
      const made = await f.request(await f.eligibleEvent());
      await f.approve(made.id, { at: new Date(Date.now() + 3600_000) });
      expect(await f.startDue()).toBe("idle");
      await f.owner(
        "UPDATE invitation_campaign SET send_at = now() - interval '1 second' WHERE id = $1",
        [made.id],
      );
      await f.switchOn(false);
      try {
        expect(await f.startDue()).toBe("off");
      } finally {
        await f.switchOn();
      }
      expect(await f.startDue()).toBe("started");
    });

    it("skips the fill while another server holds its lock", async () => {
      await f.optedIn(50);
      const made = await f.request(await f.eligibleEvent());
      await f.approve(made.id);
      const holder = await f.pool.connect();
      try {
        await holder.query("BEGIN");
        await holder.query("SELECT pg_advisory_xact_lock(hashtext('invitation_fill'))");
        expect(await f.startDue()).toBe("busy");
        await holder.query("COMMIT");
      } finally {
        holder.release();
      }
      expect(await f.startDue()).toBe("started");
    });

    it("runs in the system context only", async () => {
      for (const seat of [
        f.ownerSeat,
        f.adminSeat,
        { playerId: (await f.optedIn(1))[0] ?? "" },
        { deviceId: randomUUID() },
      ]) {
        await expect(f.run(seat, "SELECT invitation_start_due()")).rejects.toMatchObject({
          code: "IV403",
        });
      }
    });
  });

  describe("what an organizer sees", () => {
    it("never an exact count: every number is null or a multiple of 10 of at least 10 (property)", async () => {
      const event = await f.eligibleEvent();
      const made = await f.request(event);
      for (let round = 0; round < 60; round += 1) {
        const values = [0, 1, 2].map(() =>
          Math.random() < 0.15 ? null : Math.floor(Math.random() * (round < 20 ? 30 : 100_000)),
        );
        await f.owner(
          `UPDATE invitation_campaign SET published_sent = $2, published_opened = $3, published_joined = $4,
                                          sent = 9999, unknown = 7, opened = 3, joined = 1, planned = 12345
           WHERE id = $1`,
          [made.id, ...values],
        );
        const answer = invitationCampaignsSchema.parse(await listOf(event));
        const [shown] = answer.campaigns;
        for (const [index, count] of Object.values(shown?.counts ?? {}).entries()) {
          const value = values[index];
          if (value === null || value === undefined) expect(count).toBeNull();
          else if (value < 10) expect(count).toEqual({ fewerThan: 10 });
          else expect(count).toEqual({ atLeast: Math.floor(value / 10) * 10 });
        }
        const text = JSON.stringify(answer);
        for (const exact of ["9999", "12345"]) expect(text).not.toContain(exact);
      }
    });

    it("shows the campaign to editors in scope and to no one else", async () => {
      const event = await f.eligibleEvent();
      await f.request(event);
      expect((await listOf(event, f.team(f.editor))).campaigns).toHaveLength(1);
      const scoped = await addMember(f.db.owner, f.ids.orgA, "editor", [f.ids.eventA]);
      expect(await sqlstate(listOf(event, f.team(scoped)))).toBe("IV404");
      expect(await sqlstate(listOf(event, f.team(f.ownerB, f.ids.orgB)))).toBe("IV404");
      expect(await sqlstate(listOf(event, f.adminSeat))).toBe("IV404");
    });

    it("writes audit rows an organizer can read with states and criteria, never a count", async () => {
      const { campaign } = await f.launch(50);
      await f.settle();
      const rows = await f.owner<{ action: string; after: Record<string, unknown> | null }>(
        "SELECT action, after FROM audit_log WHERE target_id = $1 ORDER BY id",
        [campaign],
      );
      expect(rows.map((row) => row.action)).toEqual([
        "invitation.request",
        "invitation.approve",
        "invitation.start",
      ]);
      const allowed = [
        "state",
        "endReason",
        "cityId",
        "interests",
        "history",
        "size",
        "sendAfter",
        "channels",
        "cap",
        "sendAt",
      ];
      for (const row of rows) {
        expect(Object.keys(row.after ?? {}).every((key) => allowed.includes(key))).toBe(true);
      }
      const readable = await f.run<{ after: Record<string, unknown> }>(
        f.ownerSeat,
        "SELECT after FROM audit_log WHERE action LIKE 'invitation.%'",
      );
      expect(readable.length).toBeGreaterThan(0);
      for (const row of readable) {
        expect(
          Object.keys(row.after ?? {}).filter((key) =>
            /count|planned|sent$|opened|joined|skipped|failed|unknown/i.test(key),
          ),
        ).toEqual([]);
      }
    });

    it("gives the console the estimate and the event's live names, for admins only", async () => {
      await f.isolate();
      await f.optedIn(57);
      const event = await f.eligibleEvent();
      const made = await f.request(event);
      const read = await detail(made.id);
      expect(read.estimate).toBe(57);
      expect(read.eventIssue).toBeNull();
      expect(read.names).toEqual({
        ar: (await f.eventNames(event)).name_ar,
        en: (await f.eventNames(event)).name_en,
      });
      expect(await sqlstate(f.run(f.ownerSeat, "SELECT invitation_admin_get($1)", [made.id]))).toBe(
        "QY403",
      );
      expect(await sqlstate(f.run(f.ownerSeat, "SELECT invitation_admin_queue()"))).toBe("QY403");
      const queue = await f.one<{ campaigns: { id: string }[] }>(
        f.adminSeat,
        "SELECT invitation_admin_queue() AS r",
      );
      expect(queue.campaigns.map((campaign) => campaign.id)).toContain(made.id);
      expect(await sqlstate(detail(randomUUID()))).toBe("IV404");
    });
  });
});
