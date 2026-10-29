import { randomInt, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pushFixture, sqlstate, type PushFixture } from "#test/support/push";
import { TEST_DATABASE_URL } from "#test/support/test-db";

type Diff = { state: string; notices?: number };
type NoticeRow = {
  kind: string;
  player_id: string;
  refs: Record<string, unknown>;
  params: Record<string, unknown>;
  lifetime: string;
};
type Ranker = Readonly<{ player: string; enrollment: string }>;

const at = <T>(list: readonly T[], index: number): T => {
  const item = list[index];
  if (item === undefined) throw new Error(`no item at ${index}`);
  return item;
};

/** A rehearsal's join code is unique across events: four and four characters of the code alphabet. */
function rehearsalCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const group = () =>
    Array.from({ length: 4 }, () => alphabet.charAt(randomInt(alphabet.length))).join("");
  return `${group()}-${group()}`;
}

/**
 * The top-10 rank push in the database (T-503, migration 0082, ADR-362): the tick's diff of a live event's top ten against
 * the stored previous ten, the baseline rules, the 10-minute cooldown, who is never told, and the doors' seats.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("the top-10 rank push (database)", () => {
  let f: PushFixture;
  beforeAll(async () => {
    f = await pushFixture();
  });
  afterAll(async () => {
    await f.close();
  });

  const diff = (event: string) => f.one<Diff>(f.system, "SELECT rank_push_diff($1) AS r", [event]);
  const switchRanking = (event: string, on: boolean) =>
    f.owner(
      "UPDATE event SET config = jsonb_build_object('features', jsonb_build_object('ranking', $2::boolean)) WHERE id = $1",
      [event, on],
    );
  const switchPlatformRanking = (on: boolean) =>
    f.owner(
      `INSERT INTO platform_setting (key, value)
       VALUES ('features', jsonb_build_object('ranking', jsonb_build_object('enabled', $1::boolean)))
       ON CONFLICT (key) DO UPDATE SET value = platform_setting.value || excluded.value`,
      [on],
    );
  const noticesOf = (event: string) =>
    f.owner<NoticeRow>(
      `SELECT kind, player_id, refs, params, (expires_at - created_at)::text AS lifetime FROM notice
       WHERE event_id = $1 AND kind LIKE 'rank_top_ten%' ORDER BY id`,
      [event],
    );
  const snapshotOf = async (event: string) =>
    (
      await f.owner<{ enrollment_ids: string[] }>(
        "SELECT enrollment_ids FROM rank_top_snapshot WHERE event_id = $1",
        [event],
      )
    )[0]?.enrollment_ids;
  const ranker = async (
    event: string,
    points: number,
    via: string | null = null,
  ): Promise<Ranker> => {
    const player = await f.newPlayer();
    const enrollment = await f.join(event, player, via);
    if (points > 0) await f.earn(event, enrollment, { points });
    return { player, enrollment };
  };
  /** `count` players with 1000, 900, ... points, best first. */
  const field = async (event: string, count: number): Promise<Ranker[]> => {
    const made: Ranker[] = [];
    for (let place = 0; place < count; place += 1) {
      made.push(await ranker(event, 1000 - place * 10));
    }
    return made;
  };
  const liveEvent = () => f.newEvent({ phase: "live" });

  it("stores a baseline with no notices on the first read of an event", async () => {
    const event = await liveEvent();
    const crowd = await field(event, 12);
    expect(await diff(event)).toEqual({ state: "baseline" });
    expect(await snapshotOf(event)).toEqual(crowd.slice(0, 10).map((one) => one.enrollment));
    expect(await noticesOf(event)).toEqual([]);
    expect(await diff(event)).toEqual({ state: "diffed", notices: 0 });
  });

  it("tells the player who entered and the player who dropped out, once each, in fixed form", async () => {
    const event = await liveEvent();
    const crowd = await field(event, 12);
    await diff(event);
    await f.earn(event, at(crowd, 10).enrollment, { points: 5000 });
    expect(await diff(event)).toEqual({ state: "diffed", notices: 2 });
    const notices = await noticesOf(event);
    expect(notices.map((one) => [one.kind, one.player_id])).toEqual([
      ["rank_top_ten", at(crowd, 10).player],
      ["rank_top_ten_exit", at(crowd, 9).player],
    ]);
    for (const one of notices) {
      expect(one.refs).toEqual({});
      expect(Object.keys(one.params)).toEqual(["event"]);
      expect(one.lifetime).toBe("00:05:00");
    }
    expect(await diff(event)).toEqual({ state: "diffed", notices: 0 });
    expect(await noticesOf(event)).toHaveLength(2);
  });

  it("sends nothing for a move inside the top ten, and keeps the new order", async () => {
    const event = await liveEvent();
    const crowd = await field(event, 11);
    await diff(event);
    await f.earn(event, at(crowd, 4).enrollment, { points: 200 });
    expect(await diff(event)).toEqual({ state: "diffed", notices: 0 });
    expect((await snapshotOf(event))?.slice(0, 3)).toEqual([
      at(crowd, 4).enrollment,
      at(crowd, 0).enrollment,
      at(crowd, 1).enrollment,
    ]);
    expect(await noticesOf(event)).toEqual([]);
  });

  it("drops a blip inside 10 minutes and tells the player again after them", async () => {
    const event = await liveEvent();
    const crowd = await field(event, 12);
    await diff(event);
    const outside = at(crowd, 10);
    await f.earn(event, outside.enrollment, { points: 5000 });
    expect(await diff(event)).toEqual({ state: "diffed", notices: 2 });
    // The entrant falls out again and the player they displaced is back: both changes are inside the 10 minutes of the
    // notices each was just sent, so they are dropped, not queued.
    await f.owner("UPDATE enrollment SET score = 1 WHERE id = $1", [outside.enrollment]);
    expect(await diff(event)).toEqual({ state: "diffed", notices: 0 });
    expect(await noticesOf(event)).toHaveLength(2);
    // Ten minutes on, the same two moves are told.
    await f.owner(
      "UPDATE notice SET created_at = now() - interval '11 minutes' WHERE event_id = $1",
      [event],
    );
    await f.owner("UPDATE enrollment SET score = 5900 WHERE id = $1", [outside.enrollment]);
    expect(await diff(event)).toEqual({ state: "diffed", notices: 2 });
    const told = await noticesOf(event);
    expect(told).toHaveLength(4);
    expect(told.filter((one) => one.player_id === outside.player)).toHaveLength(2);
  });

  it("is quiet while the ranking is off or the event is not live, and starts again from a baseline", async () => {
    const event = await liveEvent();
    const crowd = await field(event, 11);
    await diff(event);
    await switchRanking(event, false);
    expect(await diff(event)).toEqual({ state: "idle" });
    expect(await snapshotOf(event)).toBeUndefined();
    await f.earn(event, at(crowd, 10).enrollment, { points: 5000 });
    await switchRanking(event, true);
    expect(await diff(event)).toEqual({ state: "baseline" });
    expect(await noticesOf(event)).toEqual([]);
    await switchPlatformRanking(false);
    try {
      expect(await diff(event)).toEqual({ state: "idle" });
    } finally {
      await switchPlatformRanking(true);
    }
    expect(await diff(event)).toEqual({ state: "baseline" });
    await f.owner("UPDATE event SET status = 'ended', ends_at = now() WHERE id = $1", [event]);
    expect(await diff(event)).toEqual({ state: "idle" });
    expect(await snapshotOf(event)).toBeUndefined();
    expect(await diff(randomUUID())).toEqual({ state: "idle" });
  });

  it("treats an event whose end has passed as not live before the lifecycle tick marks it", async () => {
    const event = await f.newEvent({ phase: "ended" });
    expect(await diff(event)).toEqual({ state: "idle" });
    expect(await snapshotOf(event)).toBeUndefined();
  });

  it("takes a rehearsal wipe as a new baseline", async () => {
    const event = await liveEvent();
    const crowd = await field(event, 11);
    await f.owner(
      `INSERT INTO event_rehearsal (event_id, organizer_id, code)
       SELECT id, organizer_id, $2 FROM event WHERE id = $1`,
      [event, rehearsalCode()],
    );
    await diff(event);
    await f.earn(event, at(crowd, 10).enrollment, { points: 5000 });
    await f.owner("UPDATE event_rehearsal SET erased_at = now() WHERE event_id = $1", [event]);
    expect(await diff(event)).toEqual({ state: "baseline" });
    expect(await noticesOf(event)).toEqual([]);
    await f.earn(event, at(crowd, 9).enrollment, { points: 9000 });
    expect((await diff(event)).state).toBe("diffed");
  });

  it("never tells a rehearsal account, and sees only players the board ranks", async () => {
    const event = await liveEvent();
    const crowd = await field(event, 10);
    await diff(event);
    const rehearsing = await ranker(event, 5000, "rehearsal");
    await diff(event);
    expect(await noticesOf(event)).toEqual([
      expect.objectContaining({ kind: "rank_top_ten_exit", player_id: at(crowd, 9).player }),
    ]);
    expect(await snapshotOf(event)).toContain(rehearsing.enrollment);
  });

  it("keeps out the players the board keeps out: excluded, operators, the team, banned and left", async () => {
    const event = await liveEvent();
    const crowd = await field(event, 10);
    await diff(event);
    const excluded = await ranker(event, 8000);
    const operator = await ranker(event, 8100);
    const banned = await ranker(event, 8200);
    const left = await ranker(event, 8300);
    const none = await ranker(event, 0);
    await f.owner(
      `INSERT INTO event_exclusion (organizer_id, event_id, kind, value)
       SELECT e.organizer_id, e.id, 'email_domain', split_part(pc.email, '@', 2)
       FROM event e, player_contact pc WHERE e.id = $1 AND pc.player_id = $2`,
      [event, excluded.player],
    );
    await f.owner(
      `INSERT INTO staff_assignment (organizer_id, event_id, player_id, can_play)
       SELECT organizer_id, id, $2, false FROM event WHERE id = $1`,
      [event, operator.player],
    );
    await f.owner("UPDATE enrollment SET status = 'banned' WHERE id = $1", [banned.enrollment]);
    await f.owner("UPDATE enrollment SET status = 'left' WHERE id = $1", [left.enrollment]);
    expect(await diff(event)).toEqual({ state: "diffed", notices: 0 });
    expect(await snapshotOf(event)).toEqual(crowd.map((one) => one.enrollment));
    expect(none.enrollment).not.toBe("");
  });

  it("lists the same ten as the board's own set form, in the same order", async () => {
    const event = await liveEvent();
    await field(event, 14);
    const strangers = [
      await ranker(event, 7000),
      await ranker(event, 7000),
      await ranker(event, 6900),
    ];
    await f.owner("UPDATE enrollment SET status = 'banned' WHERE id = $1", [
      at(strangers, 0).enrollment,
    ]);
    await f.owner("UPDATE player SET status = 'banned' WHERE id = $1", [at(strangers, 2).player]);
    const [mine] = await f.owner<{ ids: string[] }>("SELECT rank_top_ten_ids($1) AS ids", [event]);
    const board = await f.owner<{ id: string }>(
      `SELECT r.id FROM ranked_enrollments($1) r WHERE r.ranked
       ORDER BY r.score DESC, r.score_version LIMIT 10`,
      [event],
    );
    expect(mine?.ids).toEqual(board.map((row) => row.id));
    expect(mine?.ids).toHaveLength(10);
  });

  it("writes nothing and raises nothing when the kind is missing", async () => {
    const event = await liveEvent();
    const crowd = await field(event, 11);
    await diff(event);
    await f.earn(event, at(crowd, 10).enrollment, { points: 5000 });
    await f.withoutKind("rank_top_ten", async () => {
      await f.withoutKind("rank_top_ten_exit", async () => {
        expect(await diff(event)).toEqual({ state: "diffed", notices: 0 });
      });
    });
    expect(await noticesOf(event)).toEqual([]);
  });

  it("gives up the event when another runner holds it", async () => {
    const event = await liveEvent();
    await field(event, 3);
    const hold = await f.owner<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock(hashtextextended('rank_top_ten:' || $1::text, 0)) AS locked",
      [event],
    );
    expect(hold[0]?.locked).toBe(true);
    try {
      // The owner client is one session; the fixture's pool is another, so the transaction lock is refused.
      expect(await diff(event)).toEqual({ state: "busy" });
    } finally {
      await f.owner("SELECT pg_advisory_unlock(hashtextextended('rank_top_ten:' || $1::text, 0))", [
        event,
      ]);
    }
    expect((await diff(event)).state).toBe("baseline");
  });

  it("reaches the player's center row and device, and a muted topic keeps only the row", async () => {
    const event = await liveEvent();
    const crowd = await field(event, 11);
    await diff(event);
    const phone = await f.playerWithPhone();
    const mutedPhone = await f.playerWithPhone();
    const entrant = await f.join(event, phone.who);
    const quiet = await f.join(event, mutedPhone.who);
    await f.owner("INSERT INTO push_topic_mute (player_id, topic) VALUES ($1, 'rank')", [
      mutedPhone.who,
    ]);
    await f.earn(event, entrant, { points: 6000 });
    await f.earn(event, quiet, { points: 5900 });
    expect((await diff(event)).notices).toBe(4);
    await f.fanOut();
    const rows = await f.owner<{ player_id: string; kind: string }>(
      `SELECT c.player_id, n.kind FROM notification c JOIN notice n ON n.id = c.notice_id
       WHERE n.event_id = $1 ORDER BY n.id`,
      [event],
    );
    expect(
      rows
        .filter((row) => row.kind === "rank_top_ten")
        .map((row) => row.player_id)
        .toSorted(),
    ).toEqual([phone.who, mutedPhone.who].toSorted());
    const sends = await f.owner<{ player_id: string }>(
      `SELECT c.player_id FROM push_send s JOIN notification c ON c.id = s.notification_id
       JOIN notice n ON n.id = c.notice_id WHERE n.event_id = $1`,
      [event],
    );
    expect(sends.map((row) => row.player_id)).toEqual([phone.who]);
    expect(crowd).toHaveLength(11);
  });

  it("does not fan out a top-10 notice to a player who is no longer an active member", async () => {
    const event = await liveEvent();
    const crowd = await field(event, 11);
    await diff(event);
    await f.earn(event, at(crowd, 10).enrollment, { points: 5000 });
    await f.owner("UPDATE enrollment SET status = 'banned' WHERE id = $1", [
      at(crowd, 9).enrollment,
    ]);
    await f.owner("UPDATE enrollment SET status = 'left' WHERE id = $1", [
      at(crowd, 10).enrollment,
    ]);
    await diff(event);
    await f.fanOut();
    const rows = await f.owner<{ n: number }>(
      `SELECT count(*)::int AS n FROM notification c JOIN notice n ON n.id = c.notice_id
       WHERE n.event_id = $1`,
      [event],
    );
    expect(rows[0]?.n).toBe(0);
  });

  it("lists the live events, the never-read first, and drops the snapshots of the rest", async () => {
    const fresh = await liveEvent();
    const read = await liveEvent();
    const ended = await liveEvent();
    await f.owner("UPDATE event SET status = 'ended', ends_at = now() WHERE id = $1", [ended]);
    await diff(read);
    await f.owner(
      "INSERT INTO rank_top_snapshot (event_id, enrollment_ids) VALUES ($1, '{}') ON CONFLICT DO NOTHING",
      [ended],
    );
    const listed = (
      await f.run<{ rank_push_events: string }>(f.system, "SELECT * FROM rank_push_events(1000)")
    ).map((row) => row.rank_push_events);
    expect(listed).toContain(fresh);
    expect(listed).toContain(read);
    expect(listed).not.toContain(ended);
    expect(listed.indexOf(fresh)).toBeLessThan(listed.indexOf(read));
    expect(await snapshotOf(ended)).toBeUndefined();
  });

  it("answers the system seat only", async () => {
    const event = await liveEvent();
    const player = await f.newPlayer();
    const seats = [{ playerId: player }, f.team()];
    for (const seat of seats) {
      expect(await sqlstate(f.run(seat, "SELECT rank_push_diff($1)", [event]))).toBe("PN403");
      expect(await sqlstate(f.run(seat, "SELECT * FROM rank_push_events(10)"))).toBe("PN403");
    }
    expect(await snapshotOf(event)).toBeUndefined();
  });
});
