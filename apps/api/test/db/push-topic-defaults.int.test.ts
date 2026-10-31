import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pushFixture, sqlstate, type PushFixture } from "#test/support/push";
import { TEST_DATABASE_URL, addMember } from "#test/support/test-db";

const ALL_ON = { announcements: true, rank: true, community: true, reminders: true };

/**
 * An event's default notification topics (T-510, migration 0091, FR-1836, ADR-379): the layer under the player's own
 * choice, read where a push is planned and again at the claim, the player's own on and mute always winning, the team's two
 * doors with their refusals and audit, and the Settings read that says why a switch the player never touched is off.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("event topic defaults (database)", () => {
  let f: PushFixture;
  let editor = "";
  beforeAll(async () => {
    f = await pushFixture();
    editor = await addMember(f.db.owner, f.ids.orgA, "editor");
  });
  afterAll(async () => {
    await f.close();
  });

  const setDefaults = (event: string, on: string[], off: string[], staff?: string) =>
    f.run<{ r: Record<string, boolean> }>(
      f.team(staff),
      "SELECT set_event_push_defaults($1, $2::text[], $3::text[], $4) AS r",
      [event, on, off, randomUUID()],
    );
  const readDefaults = async (event: string, staff?: string) =>
    (
      await f.run<{ r: Record<string, boolean> }>(
        f.team(staff),
        "SELECT event_push_defaults($1) AS r",
        [event],
      )
    )[0]?.r;
  const choose = (who: string, on: string[], off: string[]) =>
    f.one({ playerId: who }, "SELECT set_push_topics($1::text[], $2::text[]) AS r", [on, off]);
  const own = (who: string) => f.one({ playerId: who }, "SELECT own_push_topics() AS r");
  const member = async (event: string) => {
    const who = await f.playerWithPhone();
    await f.join(event, who.who, null);
    return who;
  };
  const sendsFor = async (noticeId: string | null) => (await f.sends(noticeId)).length;

  describe("what a default does to a push", () => {
    it("a player who never chose follows the event: the center row stays, the push does not", async () => {
      await f.drain();
      const event = await f.newEvent({ phase: "live" });
      await setDefaults(event, [], ["rank"]);
      const rank = await f.kind({ class: "event", topic: "rank" });
      const announce = await f.kind({ class: "event", topic: "announcements" });
      const newcomer = await member(event);
      const a = await f.notice(rank, { event });
      const b = await f.notice(announce, { event });
      await f.fanOut();
      expect(await f.recipients(a)).toEqual([newcomer.who]);
      expect(await sendsFor(a)).toBe(0);
      expect(await sendsFor(b)).toBe(1);
      expect(
        await f.one({ playerId: newcomer.who }, "SELECT own_unread_notifications() AS r"),
      ).toBe(2);
    });

    it("a personal notice that names the event follows it too (the top-10 alert)", async () => {
      await f.drain();
      const event = await f.newEvent({ phase: "live" });
      await setDefaults(event, [], ["rank"]);
      const kind = await f.kind({ class: "personal", topic: "rank" });
      const newcomer = await member(event);
      const id = await f.notice(kind, { event, player: newcomer.who });
      await f.fanOut();
      expect(await f.recipients(id)).toEqual([newcomer.who]);
      expect(await sendsFor(id)).toBe(0);
    });

    it("the player's own choice wins: an on beats the default, a mute still mutes, a kind with no topic is untouched", async () => {
      await f.drain();
      const event = await f.newEvent({ phase: "live" });
      await setDefaults(event, [], ["rank", "announcements"]);
      const rank = await f.kind({ class: "event", topic: "rank" });
      const announce = await f.kind({ class: "event", topic: "announcements" });
      const remind = await f.kind({ class: "event", topic: "reminders" });
      const plain = await f.kind({ class: "event", topic: null });
      const turnedOn = await member(event);
      await choose(turnedOn.who, ["rank"], []);
      const muted = await member(event);
      await choose(muted.who, [], ["reminders"]);
      const ids = {
        rank: await f.notice(rank, { event }),
        announce: await f.notice(announce, { event }),
        remind: await f.notice(remind, { event }),
        plain: await f.notice(plain, { event }),
      };
      await f.fanOut();
      const reached = async (id: string | null) =>
        (await f.sends(id)).map((row) => row.device_id).toSorted();
      expect(await reached(ids.rank)).toEqual([turnedOn.deviceId]);
      expect(await reached(ids.announce)).toEqual([]);
      expect(await reached(ids.remind)).toEqual([turnedOn.deviceId]);
      expect(await reached(ids.plain)).toEqual([turnedOn.deviceId, muted.deviceId].toSorted());
    });

    it("another event's default does not reach this event, and a notice with no event ignores it", async () => {
      await f.drain();
      const strict = await f.newEvent({ phase: "live" });
      await setDefaults(strict, [], ["reminders"]);
      const open = await f.newEvent({ phase: "live" });
      const both = await f.playerWithPhone();
      await f.join(strict, both.who, null);
      await f.join(open, both.who, null);
      const remind = await f.kind({ class: "event", topic: "reminders" });
      const personal = await f.kind({ class: "personal", topic: "reminders" });
      const inOpen = await f.notice(remind, { event: open });
      const inStrict = await f.notice(remind, { event: strict });
      const streak = await f.notice(personal, { player: both.who });
      await f.fanOut();
      expect(await sendsFor(inOpen)).toBe(1);
      expect(await sendsFor(inStrict)).toBe(0);
      expect(await sendsFor(streak)).toBe(1);
    });

    it("the claim reads the layer again, in both directions", async () => {
      await f.drain();
      const event = await f.newEvent({ phase: "live" });
      const kind = await f.kind({ class: "event", topic: "rank" });
      const early = await member(event);
      const idle = await member(event);
      const id = await f.notice(kind, { event });
      await f.fanOut();
      expect(await sendsFor(id)).toBe(2);
      await setDefaults(event, [], ["rank"]);
      await choose(early.who, ["rank"], []);
      const claimed = await f.claim();
      expect(claimed.map((row) => row.token)).toEqual([early.token]);
      expect(
        (await f.sends(id)).filter((row) => row.state === "skipped").map((row) => row.code),
      ).toEqual(["muted"]);
      expect(await f.recipients(id)).toEqual([early.who, idle.who].toSorted());
    });

    it("turning a default back on sends again, and a repeated change is a no-op", async () => {
      await f.drain();
      const event = await f.newEvent({ phase: "live" });
      const off = { ...ALL_ON, community: false };
      expect((await setDefaults(event, [], ["community"]))[0]?.r).toEqual(off);
      expect((await setDefaults(event, [], ["community"]))[0]?.r).toEqual(off);
      const kind = await f.kind({ class: "event", topic: "community" });
      await member(event);
      const before = await f.notice(kind, { event });
      await f.fanOut();
      expect(await sendsFor(before)).toBe(0);
      await setDefaults(event, ["community"], []);
      const after = await f.notice(kind, { event });
      await f.fanOut();
      expect(await sendsFor(after)).toBe(1);
    });
  });

  describe("what Settings reads", () => {
    it("names the topics an event started off, until the player chooses", async () => {
      const event = await f.newEvent({ phase: "live" });
      await setDefaults(event, [], ["rank", "reminders"]);
      const who = await f.newPlayer();
      expect(await own(who)).toEqual({ ...ALL_ON, eventOff: [] });
      const enrollment = await f.join(event, who, null);
      expect(await own(who)).toEqual({
        ...ALL_ON,
        rank: false,
        reminders: false,
        eventOff: ["rank", "reminders"],
      });
      expect(await choose(who, ["rank"], ["reminders"])).toEqual({
        ...ALL_ON,
        reminders: false,
        eventOff: [],
      });
      await choose(who, [], ["rank"]);
      expect(await own(who)).toEqual({
        ...ALL_ON,
        rank: false,
        reminders: false,
        eventOff: [],
      });
      await f.owner("UPDATE enrollment SET status = 'left' WHERE id = $1", [enrollment]);
      await f.owner("DELETE FROM push_topic_mute WHERE player_id = $1", [who]);
      expect(await own(who)).toEqual({ ...ALL_ON, eventOff: [] });
    });

    it("does not count a pending member or an archived event", async () => {
      const pending = await f.newEvent({ phase: "live" });
      const archived = await f.newEvent({ phase: "archived" });
      await setDefaults(pending, [], ["rank"]);
      await setDefaults(archived, [], ["community"]);
      const who = await f.newPlayer();
      const enrollment = await f.join(pending, who, null);
      await f.join(archived, who, null);
      await f.owner("UPDATE enrollment SET status = 'pending' WHERE id = $1", [enrollment]);
      expect(await own(who)).toEqual({ ...ALL_ON, eventOff: [] });
    });

    it("changes the topics named and keeps the others; unknown and doubled topics are refused", async () => {
      const who = await f.newPlayer();
      await choose(who, ["rank"], ["community"]);
      expect(await choose(who, [], ["rank", "rank"])).toEqual({
        ...ALL_ON,
        rank: false,
        community: false,
        eventOff: [],
      });
      expect(await choose(who, ["community", "community"], [])).toEqual({
        ...ALL_ON,
        rank: false,
        eventOff: [],
      });
      expect(await f.count("push_topic_on WHERE player_id = $1", [who])).toBe(1);
      expect(await f.count("push_topic_mute WHERE player_id = $1", [who])).toBe(1);
      expect(await sqlstate(choose(who, ["offers"], []))).toBe("PN422");
      expect(await sqlstate(choose(who, [], ["offers"]))).toBe("PN422");
      expect(await sqlstate(choose(who, ["rank"], ["rank"]))).toBe("PN422");
      expect(
        await sqlstate(
          f.one({ playerId: who }, "SELECT set_push_topics('{null}'::text[], '{}') AS r"),
        ),
      ).toBe("PN422");
      expect(await choose(who, [], [])).toEqual({ ...ALL_ON, rank: false, eventOff: [] });
    });

    it("erasure deletes the player's own on topics with the mutes", async () => {
      const who = await f.newPlayer();
      await choose(who, ["rank"], ["community"]);
      expect(await f.erase(who)).toBe("erased");
      expect(await f.count("push_topic_on WHERE player_id = $1", [who])).toBe(0);
      expect(await f.count("push_topic_mute WHERE player_id = $1", [who])).toBe(0);
    });
  });

  describe("the team's doors", () => {
    it("start with everything on; an owner and an editor change them; the others stay as they were", async () => {
      const event = await f.newEvent({ phase: "live" });
      expect(await readDefaults(event)).toEqual(ALL_ON);
      expect((await setDefaults(event, [], ["rank"]))[0]?.r).toEqual({ ...ALL_ON, rank: false });
      expect((await setDefaults(event, [], ["community"], editor))[0]?.r).toEqual({
        ...ALL_ON,
        rank: false,
        community: false,
      });
      expect((await setDefaults(event, ["rank"], []))[0]?.r).toEqual({
        ...ALL_ON,
        community: false,
      });
      expect(await readDefaults(event, editor)).toEqual({ ...ALL_ON, community: false });
    });

    it("audits a change with the before and the after, and a repeat writes nothing", async () => {
      const event = await f.newEvent({ phase: "live" });
      const audits = () =>
        f.owner<{ before: Record<string, boolean>; after: Record<string, boolean> }>(
          "SELECT before, after FROM audit_log WHERE event_id = $1 AND action = 'push.defaults' ORDER BY id",
          [event],
        );
      await setDefaults(event, [], ["rank"]);
      await setDefaults(event, [], ["rank"]);
      await setDefaults(event, ["announcements"], []);
      expect(await audits()).toEqual([{ before: ALL_ON, after: { ...ALL_ON, rank: false } }]);
    });

    it("refuse an unknown topic, a topic named twice and a request with nothing to change", async () => {
      const event = await f.newEvent({ phase: "live" });
      expect(await sqlstate(setDefaults(event, [], ["offers"]))).toBe("PN422");
      expect(await sqlstate(setDefaults(event, ["rank"], ["rank"]))).toBe("PN422");
      expect(await readDefaults(event)).toEqual(ALL_ON);
      expect((await setDefaults(event, [], []))[0]?.r).toEqual(ALL_ON);
    });

    it("do not reach another organizer's event, a scoped editor's other event, or any seat without a team", async () => {
      const event = await f.newEvent({ phase: "live" });
      const other = await f.newEvent({ phase: "live" });
      const scoped = await addMember(f.db.owner, f.ids.orgA, "editor", [other]);
      const ownerB = await addMember(f.db.owner, f.ids.orgB, "owner");
      const asB = f.team(ownerB, f.ids.orgB);
      for (const [context, sql] of [
        [asB, "SELECT event_push_defaults($1) AS r"],
        [asB, "SELECT set_event_push_defaults($1, '{}', '{rank}', gen_random_uuid()) AS r"],
        [f.team(scoped), "SELECT event_push_defaults($1) AS r"],
        [
          f.team(scoped),
          "SELECT set_event_push_defaults($1, '{}', '{rank}', gen_random_uuid()) AS r",
        ],
        [{}, "SELECT event_push_defaults($1) AS r"],
        [{}, "SELECT set_event_push_defaults($1, '{}', '{rank}', gen_random_uuid()) AS r"],
      ] as const) {
        expect(await sqlstate(f.run(context, sql, [event])), sql).toBe("AN404");
      }
      expect(
        await sqlstate(
          f.run(f.team(scoped), "SELECT set_event_push_defaults($1, '{}', '{rank}', NULL) AS r", [
            other,
          ]),
        ),
      ).toBe("none");
      expect(await readDefaults(event)).toEqual(ALL_ON);
    });

    it("a player cannot read or change an event's defaults", async () => {
      const event = await f.newEvent({ phase: "live" });
      const who = await f.newPlayer();
      expect(await sqlstate(f.asPlayer(who, "SELECT event_push_defaults($1) AS r", [event]))).toBe(
        "AN404",
      );
      expect(
        await sqlstate(
          f.asPlayer(who, "SELECT set_event_push_defaults($1, '{}', '{rank}', NULL) AS r", [event]),
        ),
      ).toBe("AN404");
    });

    it("keep every change when two members save at once, and go with the event", async () => {
      const event = await f.newEvent({ phase: "live" });
      await Promise.all([
        setDefaults(event, [], ["rank"]),
        setDefaults(event, [], ["community"], editor),
        setDefaults(event, [], ["reminders"]),
        setDefaults(event, [], ["announcements"], editor),
      ]);
      expect(await readDefaults(event)).toEqual({
        announcements: false,
        rank: false,
        community: false,
        reminders: false,
      });
      expect(
        await f.count("audit_log WHERE event_id = $1 AND action = 'push.defaults'", [event]),
      ).toBe(4);
      const gone = await f.newEvent({ phase: "scheduled" });
      await setDefaults(gone, [], ["rank"]);
      await f.owner("DELETE FROM event WHERE id = $1", [gone]);
      expect(await f.count("event_topic_off WHERE event_id = $1", [gone])).toBe(0);
    });
  });
});
