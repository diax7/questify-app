import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pushMessageOf, type ClaimedSend } from "#src/push/message";
import { invitationFixture, sqlstate, type InvitationFixture } from "#test/support/invitations";
import { pushFixture, type PushFixture } from "#test/support/push";
import { questifyFixture, type QuestifyFixture } from "#test/support/questify";
import { TEST_DATABASE_URL } from "#test/support/test-db";

type NoticeRow = {
  id: string;
  player_id: string;
  event_id: string;
  refs: Record<string, unknown>;
  params: Record<string, unknown>;
  dedupe: string;
  expires_at: Date;
};
type Hand = Readonly<{ rows: number; more: boolean }>;

/**
 * Questify invitations by push (T-501f, migration 0079; ADR-356 (4) to (6)): the fill gives each chosen player one
 * channel (push with consent on push and a pushable device, else SMS; never both), the hand-off writes one notice per
 * push row (consent and membership checked again), consent is checked again at the fan-out and the claim (no center row
 * without it), a broken kind never undoes the door, the markers hold across re-runs, the open is counted once from the
 * center, the hand-off runs in the system seat only and waits for both switches, and the claim asks again whether the
 * event still takes an invitation.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("invitations by push (database)", () => {
  let q: QuestifyFixture;
  let p: PushFixture;
  let iv: InvitationFixture;
  beforeAll(async () => {
    q = await questifyFixture();
    p = await pushFixture(q);
    iv = await invitationFixture(q);
  });
  afterAll(async () => {
    await q.close();
  });
  beforeEach(async () => {
    await iv.switchOn();
  });

  const hand = () => iv.one<Hand>(iv.system, "SELECT invitation_push_hand() AS r");
  const invitations = (event: string) =>
    q.owner<NoticeRow>(
      `SELECT id, player_id, event_id, refs, params, dedupe, expires_at FROM notice
       WHERE kind = 'invitation' AND event_id = $1 ORDER BY id`,
      [event],
    );
  const withdrawPush = (player: string) =>
    q.owner(
      "INSERT INTO marketing_consent (player_id, channel, granted, method) VALUES ($1, 'push', false, 'settings')",
      [player],
    );
  /** Turns everyone's push consent off, so the next fill sees only the players a test made. */
  const isolatePush = () =>
    q.owner(
      `INSERT INTO marketing_consent (player_id, channel, granted, method)
       SELECT s.player_id, 'push', false, 'settings' FROM marketing_state s WHERE s.channel = 'push' AND s.opted_in`,
    );
  /** `n` players opted in on SMS and on push, each with a pushable phone. */
  const pushReady = async (n: number) => {
    const players = await iv.optedIn(n);
    const phones = new Map<string, string>();
    for (const player of players) {
      await p.consentPush(player);
      phones.set(player, (await p.phone(player)).token);
    }
    return { players, phones };
  };
  /** A started campaign on `channels` over 50 players ready for push (and `extra` SMS-only players). */
  const launch = async (channels: string[] = ["push", "sms"], extra = 0) => {
    await iv.reset();
    await isolatePush();
    const ready = await pushReady(50);
    const smsOnly = extra === 0 ? [] : await iv.optedIn(extra);
    const event = await iv.eligibleEvent();
    const campaign = (await iv.request(event)).id;
    await iv.approve(campaign, { channels });
    expect(await iv.startDue()).toBe("started");
    return { event, campaign, ...ready, smsOnly };
  };
  const channelOf = async (campaign: string) =>
    new Map((await iv.recipients(campaign)).map((row) => [row.player_id, row] as const));
  const channelsOf = async (campaign: string) =>
    new Map(
      (
        await q.owner<{ player_id: string; channel: string }>(
          "SELECT player_id, channel FROM invitation_recipient WHERE campaign_id = $1",
          [campaign],
        )
      ).map((row) => [row.player_id, row.channel] as const),
    );

  describe("the fill", () => {
    it("gives each player one channel: push with push consent and a pushable phone, else SMS; the phone alone is no consent", async () => {
      await iv.reset();
      await isolatePush();
      const filler = await iv.optedIn(50);
      const [both, noDevice, deviceOnly] = await iv.optedIn(3);
      await p.consentPush(both ?? "");
      await p.phone(both ?? "");
      await p.consentPush(noDevice ?? "");
      await p.phone(deviceOnly ?? "");
      const pushOnly = await q.newPlayer();
      await p.consentPush(pushOnly);
      await p.phone(pushOnly);
      const nobody = await q.newPlayer();
      await q.owner("UPDATE player SET birth_year = 1990 WHERE id = $1", [nobody]);
      await p.phone(nobody);
      const event = await iv.eligibleEvent();
      const campaign = (await iv.request(event)).id;
      await iv.approve(campaign, { channels: ["sms", "push"] });
      expect((await iv.campaignRow(campaign)).state).toBe("approved");
      expect(await iv.startDue()).toBe("started");
      const chosen = await channelsOf(campaign);
      expect(chosen.get(both ?? "")).toBe("push");
      expect(chosen.get(pushOnly)).toBe("push");
      expect(chosen.get(noDevice ?? "")).toBe("sms");
      expect(chosen.get(deviceOnly ?? "")).toBe("sms");
      expect(chosen.has(nobody)).toBe(false);
      for (const player of filler) expect(chosen.get(player)).toBe("sms");
      expect(chosen.size).toBe(54);
    });

    it("on push alone invites only players ready for push, and on SMS alone never by push", async () => {
      const pushed = await launch(["push"], 5);
      const chosen = await channelsOf(pushed.campaign);
      expect([...chosen.values()].every((channel) => channel === "push")).toBe(true);
      expect(new Set(chosen.keys())).toEqual(new Set(pushed.players));
      const texted = await launch(["sms"]);
      expect(new Set((await channelsOf(texted.campaign)).values())).toEqual(new Set(["sms"]));
    });

    it("refuses any channel but push and SMS in the table itself", async () => {
      const { campaign } = await launch();
      expect(
        await sqlstate(
          q.owner("UPDATE invitation_campaign SET channels = '{push,email}' WHERE id = $1", [
            campaign,
          ]),
        ),
      ).toBe("23514");
    });
  });

  describe("the hand-off", () => {
    it("writes one notice per push row and marks it sent, never touches an SMS row, and a re-run writes nothing", async () => {
      const { event, campaign, players, smsOnly } = await launch(["push", "sms"], 3);
      const answer = await hand();
      expect(answer).toEqual({ rows: 50, more: false });
      const notices = await invitations(event);
      expect(notices.map((row) => row.player_id).toSorted()).toEqual(players.toSorted());
      const rows = await channelOf(campaign);
      const [names] = await q.owner<{ join_code: string; ends_at: Date }>(
        "SELECT join_code, ends_at FROM event WHERE id = $1",
        [event],
      );
      const frozen = await iv.campaignRow(campaign);
      for (const notice of notices) {
        const row = rows.get(notice.player_id);
        expect(row).toMatchObject({ state: "sent" });
        expect(row?.sent_at).not.toBeNull();
        expect(notice.dedupe).toBe(`invitation:${row?.id}`);
        expect(notice.refs).toEqual({ recipient: Number(row?.id) });
        expect(notice.params).toEqual({
          event: { ar: frozen.name_ar, en: frozen.name_en },
          code: names?.join_code,
        });
        expect(notice.expires_at.getTime()).toBeLessThanOrEqual(names?.ends_at.getTime() ?? 0);
      }
      for (const player of smsOnly) expect(rows.get(player)?.state).toBe("queued");
      expect(await iv.campaignRow(campaign)).toMatchObject({ sent: 50, skipped: 0, failed: 0 });
      expect(await hand()).toEqual({ rows: 0, more: false });
      expect(await invitations(event)).toHaveLength(50);
      // The SMS rounds claim the SMS rows only: one message per player per campaign, never both channels.
      const claimed = await iv.claimAt(5);
      expect(new Set(claimed.map((row) => row.player_id))).toEqual(new Set(smsOnly));
      for (const one of claimed) await iv.ack(one, "sent");
      expect(await iv.claimAt(5)).toEqual([]);
      const texted = new Set(claimed.map((row) => row.player_id));
      expect(notices.filter((row) => texted.has(row.player_id))).toEqual([]);
      expect(await iv.campaignRow(campaign)).toMatchObject({ sent: 53 });
    });

    it("checks consent and membership again: withdrawn is opted_out, joined is member, and neither falls back to SMS", async () => {
      const { event, campaign, players } = await launch();
      const [withdrew, joined] = players;
      await withdrawPush(withdrew ?? "");
      await q.join(event, joined ?? "");
      await hand();
      const rows = await channelOf(campaign);
      expect(rows.get(withdrew ?? "")).toMatchObject({
        state: "skipped",
        skip_reason: "opted_out",
      });
      expect(rows.get(joined ?? "")).toMatchObject({ state: "skipped", skip_reason: "member" });
      const notified = new Set((await invitations(event)).map((row) => row.player_id));
      expect(notified.has(withdrew ?? "")).toBe(false);
      expect(notified.has(joined ?? "")).toBe(false);
      expect(await iv.campaignRow(campaign)).toMatchObject({ sent: 48, skipped: 2 });
      expect(await iv.claimAt(5)).toEqual([]);
    });

    it("no center row without consent; consent withdrawn or a join after the fan-out skips the push", async () => {
      const { event, players, phones } = await launch();
      const [early, late, joins, kept] = players;
      await hand();
      await withdrawPush(early ?? "");
      await p.drain();
      await p.fanOut();
      const notices = await invitations(event);
      const recipients = new Set(
        (
          await q.owner<{ player_id: string }>(
            "SELECT player_id FROM notification WHERE notice_id = ANY ($1::bigint[])",
            [notices.map((row) => row.id)],
          )
        ).map((row) => row.player_id),
      );
      expect(recipients.has(early ?? "")).toBe(false);
      expect(recipients.size).toBe(49);
      await withdrawPush(late ?? "");
      await q.join(event, joins ?? "");
      const claimed = (await p.claim()) as unknown as ClaimedSend[];
      const tokens = new Set(claimed.map((row) => row.token));
      expect(tokens.has(phones.get(late ?? "") ?? "")).toBe(false);
      expect(tokens.has(phones.get(joins ?? "") ?? "")).toBe(false);
      const mine = claimed.find((row) => row.token === phones.get(kept ?? ""));
      expect(mine).toMatchObject({ kind: "invitation", class: "promo", topic: null, priority: 2 });
      const message = mine === undefined ? null : pushMessageOf({ ...mine, language: "en" });
      expect(message).toMatchObject({ priority: "normal", channel: "offers" });
      expect(message?.body).toMatch(/^You have an invitation to .+\.$/);
      expect(JSON.parse(String(message?.data["r"]))).toEqual({
        recipient: expect.stringMatching(/^[0-9]+$/),
      });
      const skipped = await q.owner<{ player_id: string; code: string }>(
        `SELECT c.player_id, s.code FROM push_send s JOIN notification c ON c.id = s.notification_id
         WHERE s.state = 'skipped' AND s.notice_id = ANY ($1::bigint[])`,
        [notices.map((row) => row.id)],
      );
      expect(new Map(skipped.map((row) => [row.player_id, row.code]))).toEqual(
        new Map([
          [late ?? "", "consent"],
          [joins ?? "", "not_member"],
        ]),
      );
      // The withdrawn player's center row stays; the push did not go.
      expect(await p.count("notification WHERE player_id = $1", [late ?? ""])).toBe(1);
    });

    it("a broken kind cannot roll back the hand-off: the rows fail (no_kind) and the door commits", async () => {
      const { event, campaign } = await launch(["push"]);
      await p.withoutKind("invitation", async () => {
        expect(await hand()).toEqual({ rows: 50, more: false });
      });
      expect(await invitations(event)).toEqual([]);
      expect(await iv.statesOf(campaign)).toEqual({ failed: 50 });
      expect((await iv.recipients(campaign)).every((row) => row.error_code === "no_kind")).toBe(
        true,
      );
      expect(await iv.campaignRow(campaign)).toMatchObject({ failed: 50, sent: 0 });
      expect(await hand()).toEqual({ rows: 0, more: false });
    });

    it("runs in the system seat only, and hands nothing over while the switch is off", async () => {
      const { campaign, players } = await launch(["push"]);
      for (const seat of [
        iv.ownerSeat,
        iv.adminSeat,
        { playerId: players[0] ?? "" },
        { deviceId: randomUUID() },
      ]) {
        expect(await sqlstate(iv.run(seat, "SELECT invitation_push_hand()"))).toBe("IV403");
      }
      await iv.switchOn(false);
      expect(await hand()).toEqual({ rows: 0, more: false });
      expect(await iv.statesOf(campaign)).toEqual({ queued: 50 });
    });

    it("hands nothing over while the platform push switch is off: the rows stay queued and go out once it is on", async () => {
      const { event, campaign } = await launch(["push"]);
      await p.switchPush(false);
      try {
        expect(await hand()).toEqual({ rows: 0, more: false });
        expect(await iv.statesOf(campaign)).toEqual({ queued: 50 });
        expect(await iv.campaignRow(campaign)).toMatchObject({ sent: 0, failed: 0, skipped: 0 });
        expect(await invitations(event)).toEqual([]);
      } finally {
        await p.switchPush(true);
      }
      expect(await hand()).toEqual({ rows: 50, more: false });
      expect(await iv.statesOf(campaign)).toEqual({ sent: 50 });
      expect(await invitations(event)).toHaveLength(50);
    });

    it.each([
      ["private", "UPDATE event SET access = 'private' WHERE id = $1"],
      ["unlisted", "UPDATE event SET access = 'unlisted' WHERE id = $1"],
      ["guest-list-only", "UPDATE event SET guest_list_only = true WHERE id = $1"],
    ])(
      "an event made %s after the hand-off gets no push, as the SMS claim would skip it",
      async (_, change) => {
        const { event, phones } = await launch(["push"]);
        await hand();
        await p.drain();
        await p.fanOut();
        await q.owner(change, [event]);
        const claimed = (await p.claim()) as unknown as ClaimedSend[];
        const tokens = new Set(claimed.map((row) => row.token));
        for (const token of phones.values()) expect(tokens.has(token)).toBe(false);
        const skipped = await q.owner<{ code: string }>(
          `SELECT s.code FROM push_send s WHERE s.state = 'skipped' AND s.notice_id = ANY ($1::bigint[])`,
          [(await invitations(event)).map((row) => row.id)],
        );
        expect(skipped).toHaveLength(50);
        expect(new Set(skipped.map((row) => row.code))).toEqual(new Set(["not_member"]));
      },
    );
  });

  describe("the open (ADR-356 (5))", () => {
    it("counts once when the player opens the invitation's center row, never for another player or 'mark all'", async () => {
      const { event, campaign, players } = await launch(["push"]);
      await hand();
      await p.fanOut();
      const rowOf = async (player: string) =>
        (
          await q.owner<{ id: string }>(
            `SELECT c.id FROM notification c JOIN notice nt ON nt.id = c.notice_id
             WHERE c.player_id = $1 AND nt.kind = 'invitation' AND nt.event_id = $2`,
            [player, event],
          )
        )[0]?.id ?? "";
      const [opener, stranger, marksAll] = players;
      const read = (player: string, ids: string[] | null) =>
        iv.one<number>({ playerId: player }, "SELECT mark_notifications_read($1::bigint[]) AS r", [
          ids,
        ]);
      const mine = await rowOf(opener ?? "");
      await read(stranger ?? "", [mine]);
      expect((await iv.campaignRow(campaign)).opened).toBe(0);
      await read(opener ?? "", [mine]);
      await read(opener ?? "", [mine]);
      await read(marksAll ?? "", null);
      expect((await iv.campaignRow(campaign)).opened).toBe(1);
      const rows = await channelOf(campaign);
      expect(rows.get(opener ?? "")?.opened_at).not.toBeNull();
      expect(rows.get(stranger ?? "")?.opened_at).toBeNull();
      expect(rows.get(marksAll ?? "")?.opened_at).toBeNull();
    });

    it("counts no open once the event is over", async () => {
      const { event, campaign, players } = await launch(["push"]);
      await hand();
      await p.fanOut();
      const [late] = players;
      const [row] = await q.owner<{ id: string }>(
        `SELECT c.id FROM notification c JOIN notice nt ON nt.id = c.notice_id
         WHERE c.player_id = $1 AND nt.event_id = $2`,
        [late, event],
      );
      await iv.endEventIn(event, "-1 minute");
      await iv.one({ playerId: late ?? "" }, "SELECT mark_notifications_read($1::bigint[]) AS r", [
        [row?.id],
      ]);
      expect((await iv.campaignRow(campaign)).opened).toBe(0);
    });

    it("counts the opens of rows from two campaigns in one call, locking the campaigns in id order: a claim holding the lower one and taking the higher one does not deadlock", async () => {
      await iv.reset();
      await isolatePush();
      const { players } = await pushReady(50);
      const requested = [await iv.eligibleEvent(), await iv.eligibleEvent()];
      const [low = "", high = ""] = (
        await Promise.all(requested.map(async (event) => (await iv.request(event)).id))
      ).toSorted();
      // The higher campaign is filled first, so its recipient rows come first in recipient order: the order an
      // unordered open would lock in.
      await iv.approve(high, { channels: ["push"], at: new Date(Date.now() - 30_000) });
      await iv.approve(low, { channels: ["push"] });
      expect(await iv.startDue()).toBe("started");
      await hand();
      await q.owner(
        "UPDATE invitation_recipient SET sent_at = now() - interval '8 days' WHERE campaign_id = $1",
        [high],
      );
      expect(await iv.startDue()).toBe("started");
      await hand();
      await p.fanOut();
      const [reader] = players;
      const centerRows = await q.owner<{ id: string }>(
        `SELECT c.id FROM notification c JOIN notice nt ON nt.id = c.notice_id
         WHERE c.player_id = $1 AND nt.kind = 'invitation' ORDER BY c.id`,
        [reader],
      );
      expect(centerRows).toHaveLength(2);

      const claim = new Client({ connectionString: ownerUrl() });
      await claim.connect();
      let outcome: unknown = "never ran";
      try {
        await claim.query("BEGIN");
        await claim.query("SELECT 1 FROM invitation_campaign WHERE id = $1 FOR NO KEY UPDATE", [
          low,
        ]);
        const reading = iv
          .one({ playerId: reader ?? "" }, "SELECT mark_notifications_read($1::bigint[]) AS r", [
            centerRows.map((row) => row.id),
          ])
          .then(
            () => undefined,
            (error: unknown) => error,
          );
        await waitsOnLock("mark_notifications_read");
        await claim.query("SELECT 1 FROM invitation_campaign WHERE id = $1 FOR NO KEY UPDATE", [
          high,
        ]);
        await claim.query("COMMIT");
        outcome = await reading;
      } finally {
        await claim.query("ROLLBACK").catch(() => undefined);
        await claim.end();
      }
      expect(outcome).toBeUndefined();
      expect((await iv.campaignRow(low)).opened).toBe(1);
      expect((await iv.campaignRow(high)).opened).toBe(1);
    });
  });

  /** The owner's connection string for this suite's database, for a transaction a test holds open by hand. */
  const ownerUrl = (): string => {
    const url = new URL(TEST_DATABASE_URL ?? "");
    url.pathname = new URL(q.db.appUrl).pathname;
    return url.toString();
  };
  /** Waits until a backend running `fragment` waits on a lock. */
  const waitsOnLock = async (fragment: string): Promise<void> => {
    for (let tries = 0; tries < 200; tries += 1) {
      const rows = await q.owner(
        `SELECT 1 FROM pg_stat_activity
         WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE $1`,
        [`%${fragment}%`],
      );
      if (rows.length > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`${fragment} never waited on a lock`);
  };
});
