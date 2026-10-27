import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { questifyFixture, type QuestifyFixture } from "#test/support/questify";
import { TEST_DATABASE_URL } from "#test/support/test-db";

type Recap = {
  status_now: string;
  name: { ar: string; en: string };
  local_date: string;
  city: { ar: string; en: string } | null;
  rank: number | null;
  rank_state: string;
  quests_done: number;
  souvenirs: { id: string; kind: string; name: { ar: string; en: string } }[];
};

/**
 * The recap in the database (T-410, migration 0074, ADR-339): one row for a member who played as the passport counts
 * it, the rank by own_events' rule, the quests done from the ledger with removals excluded (never XP credits), the
 * event's souvenirs in earned order, and nothing for anyone else.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("event_recap (database)", () => {
  let f: QuestifyFixture;
  let counter = 0;

  beforeAll(async () => {
    f = await questifyFixture();
  });
  afterAll(async () => {
    await f.close();
  });

  const recap = async (player: string, event: string) =>
    f.asPlayer<Recap>(player, "SELECT * FROM event_recap($1)", [event]);
  const one = async (player: string, event: string): Promise<Recap> => {
    const rows = await recap(player, event);
    expect(rows).toHaveLength(1);
    return rows[0] as Recap;
  };

  /** A member of `event` with a new player; `via` is the enrollment's joined_via. */
  const member = async (event: string, via: string | null = "code") => {
    const player = await f.newPlayer();
    const enrollment = await f.join(event, player, via);
    return { player, enrollment };
  };

  /** One completion of `quest` (its `occurrence`), written as the ledger writes it; returns the entry. */
  const credit = async (event: string, enrollment: string, quest: string, occurrence: number) => {
    const [organizer] = await f.owner<{ organizer_id: string }>(
      "SELECT organizer_id FROM event WHERE id = $1",
      [event],
    );
    const [done] = await f.owner<{ id: string }>(
      `INSERT INTO quest_completion (organizer_id, event_id, enrollment_id, quest_id, occurrence, method,
                                     idempotency_key)
       VALUES ($1, $2, $3, $4, $5, 'qr', $6) RETURNING id`,
      [organizer?.organizer_id, event, enrollment, quest, occurrence, randomUUID()],
    );
    const [entry] = await f.owner<{ id: string }>(
      `INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta,
                                 completion_id, quest_id, actor)
       VALUES ($1, $2, $3, 'quest', 10, 10, $4, $5, 'player') RETURNING id`,
      [organizer?.organizer_id, event, enrollment, done?.id, quest],
    );
    return entry?.id ?? "";
  };
  const newQuest = async (event: string) =>
    (
      await f.owner<{ id: string }>(
        `INSERT INTO quest (event_id, category_id, type, title_en, points, repeat_cap, visible, type_config)
         SELECT $1, id, 'scan_qr', 'Quest', 10, 100, true, '{}' FROM category WHERE event_id = $1 LIMIT 1
         RETURNING id`,
        [event],
      )
    )[0]?.id ?? "";

  /** A souvenir of `event` earned by the member at `minutesAgo`, as souvenir_evaluate writes it. */
  const souvenir = async (
    event: string,
    who: { player: string; enrollment: string },
    minutesAgo: number,
  ): Promise<string> => {
    counter += 1;
    const item = `recap-souvenir-${counter}`;
    await f.owner("INSERT INTO item (id, kind, name_ar, name_en) VALUES ($1, 'title', $2, $3)", [
      item,
      `تذكار ${counter}`,
      `Souvenir ${counter}`,
    ]);
    const [rule] = await f.owner<{ id: string }>(
      `INSERT INTO souvenir_rule (organizer_id, event_id, item_id, audience, status, activated_at)
       SELECT organizer_id, id, $2, 'joined', 'active', now() FROM event WHERE id = $1 RETURNING id`,
      [event, item],
    );
    const at = new Date(Date.now() - minutesAgo * 60_000);
    await f.owner(
      `INSERT INTO souvenir_receipt (rule_id, event_id, item_id, player_id, enrollment_id, earned_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [rule?.id, event, item, who.player, who.enrollment, at],
    );
    await f.owner(
      `INSERT INTO player_item (player_id, item_id, source, source_rule_id, source_event_id, earned_at)
       VALUES ($1, $2, 'souvenir', $3, $4, $5)`,
      [who.player, item, rule?.id, event, at],
    );
    return item;
  };

  it("answers a live event's member with the event and the live state", async () => {
    const event = await f.newEvent({ phase: "live", cityId: "sa-riyadh" });
    const who = await member(event);
    const row = await one(who.player, event);
    expect(row).toMatchObject({
      status_now: "live",
      name: { ar: "فعالية", en: expect.stringMatching(/^Event \d+$/) },
      city: { en: "Riyadh" },
      rank: null,
      rank_state: "live",
      quests_done: 0,
      souvenirs: [],
    });
    expect(row.local_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("gives the rank as own_events does: pending, then final or unranked once revealed", async () => {
    const event = await f.newEvent();
    const first = await member(event);
    const second = await member(event);
    const idle = await member(event);
    await f.earn(event, first.enrollment, { points: 30 });
    await f.earn(event, second.enrollment, { points: 10 });
    const own = async (player: string) =>
      (
        await f.asPlayer<{ rank: number | null; rank_state: string }>(
          player,
          "SELECT rank, rank_state FROM own_events(false, NULL, NULL, 50) WHERE event_id = $1",
          [event],
        )
      )[0];
    const pair = async (player: string) => {
      const row = await one(player, event);
      return { rank: row.rank, rank_state: row.rank_state };
    };
    for (const who of [first, second, idle]) {
      expect(await pair(who.player)).toEqual({ rank: null, rank_state: "pending" });
      expect(await pair(who.player)).toEqual(await own(who.player));
    }
    expect(await f.confirm(event)).toBe("confirmed");
    expect(await pair(first.player)).toEqual({ rank: null, rank_state: "pending" });
    expect(await f.reveal(event)).toBe("revealed");
    expect(await pair(first.player)).toEqual({ rank: 1, rank_state: "final" });
    expect(await pair(second.player)).toEqual({ rank: 2, rank_state: "final" });
    expect(await pair(idle.player)).toEqual({ rank: null, rank_state: "unranked" });
    for (const who of [first, second, idle]) {
      expect(await pair(who.player)).toEqual(await own(who.player));
    }
  });

  it("counts distinct quests done, a repeat once and a removed award not at all", async () => {
    const event = await f.newEvent();
    const who = await member(event);
    const twice = await newQuest(event);
    const removed = await newQuest(event);
    await credit(event, who.enrollment, twice, 1);
    await credit(event, who.enrollment, twice, 2);
    const gone = await credit(event, who.enrollment, removed, 1);
    expect((await one(who.player, event)).quests_done).toBe(2);
    await f.removeEntry(event, gone);
    expect((await one(who.player, event)).quests_done).toBe(1);
  });

  it("counts a quest whose first completion was removed and then done again (XP credits would drop it)", async () => {
    const event = await f.newEvent();
    const who = await member(event);
    const quest = await newQuest(event);
    const first = await credit(event, who.enrollment, quest, 1);
    await f.removeEntry(event, first);
    await credit(event, who.enrollment, quest, 2);
    expect((await one(who.player, event)).quests_done).toBe(1);
    // XP pays a quest's first completion only, and the removal reversed it: no standing credit is left.
    const standing = await f.owner(
      `SELECT x.id FROM xp_entry x JOIN ledger_entry l ON l.id = x.ledger_entry_id
       WHERE l.enrollment_id = $1 AND x.source = 'quest'
         AND NOT EXISTS (SELECT 1 FROM xp_entry r WHERE r.source = 'removal' AND r.reverses = x.id)`,
      [who.enrollment],
    );
    expect(standing).toEqual([]);
  });

  it("lists this event's souvenirs in earned order, none for a member with none", async () => {
    const event = await f.newEvent();
    const other = await f.newEvent();
    const none = await member(event);
    const single = await member(event);
    const many = await member(event);
    const lone = await souvenir(event, single, 30);
    const order = [
      await souvenir(event, many, 10),
      await souvenir(event, many, 40),
      await souvenir(event, many, 20),
      await souvenir(event, many, 30),
    ];
    const elsewhere = { player: many.player, enrollment: await f.join(other, many.player) };
    await souvenir(other, elsewhere, 50);
    expect((await one(none.player, event)).souvenirs).toEqual([]);
    expect((await one(single.player, event)).souvenirs).toEqual([
      {
        id: lone,
        kind: "title",
        name: { ar: expect.any(String), en: expect.any(String) },
        visualKey: null,
      },
    ]);
    const ids = (await one(many.player, event)).souvenirs.map((item) => item.id);
    expect(ids).toEqual([order[1], order[3], order[2], order[0]]);
  });

  it("answers a member who left and one whose joined_via is NULL (enrollments before 0018)", async () => {
    const event = await f.newEvent();
    const left = await member(event);
    await f.owner("UPDATE enrollment SET status = 'left' WHERE id = $1", [left.enrollment]);
    const older = await member(event, null);
    expect((await one(left.player, event)).status_now).toBe("ended");
    expect((await one(older.player, event)).status_now).toBe("ended");
  });

  it("answers no row to a rehearsal account, or a banned, removed, pending or declined member", async () => {
    const event = await f.newEvent();
    const rehearsal = await member(event, "rehearsal");
    expect(await recap(rehearsal.player, event)).toEqual([]);
    for (const status of ["banned", "removed", "pending", "declined"]) {
      const who = await member(event);
      await f.owner("UPDATE enrollment SET status = $2 WHERE id = $1", [who.enrollment, status]);
      expect(await recap(who.player, event), status).toEqual([]);
    }
  });

  it("answers nothing about another player, another organizer's event, an unknown event or a banned player", async () => {
    const event = await f.newEvent();
    const theirs = await f.newEvent({ organizer: f.ids.orgB });
    const mine = await member(event);
    const outsider = await member(theirs);
    await f.earn(event, mine.enrollment);
    expect(await recap(outsider.player, event)).toEqual([]);
    expect(await recap(mine.player, theirs)).toEqual([]);
    expect(await recap(mine.player, randomUUID())).toEqual([]);
    const stranger = await f.newPlayer();
    expect(await recap(stranger, event)).toEqual([]);
    await f.owner("UPDATE player SET status = 'banned' WHERE id = $1", [mine.player]);
    expect(await recap(mine.player, event)).toEqual([]);
  });

  it("answers no row without a player in the request", async () => {
    const event = await f.newEvent();
    await member(event);
    expect(await f.run(f.team(), "SELECT * FROM event_recap($1)", [event])).toEqual([]);
    expect(await f.run({}, "SELECT * FROM event_recap($1)", [event])).toEqual([]);
  });
});
