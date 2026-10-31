import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { questifyFixture, type QuestifyFixture } from "#test/support/questify";
import { TEST_DATABASE_URL } from "#test/support/test-db";

type Door<T> = { door: T };
type Participation = {
  joined: number;
  active: number;
  activation: number | null;
  returning: number;
  rehearsal: boolean;
  unit: string;
  series: { at: string; joined: number }[];
  sources: Record<string, number>;
};
type QuestsAnswer = {
  joined: number;
  categories: {
    id: string;
    name: { ar: string | null; en: string | null };
    inOrder: boolean;
    quests: { id: string; title: unknown; done: number; step: boolean; skipped: boolean }[];
  }[];
};
type Economy = {
  earned: number;
  spent: number;
  unclaimed: number;
  rewards: {
    id: string;
    name: { en: string | null };
    price: number;
    redeemed: number;
    unclaimed: number;
    stockLeft: number;
    removed: boolean;
  }[];
};

const refusal = (work: Promise<unknown>): Promise<string> =>
  work.then(
    () => "none",
    (error: { code?: string }) => `${error.code}`,
  );

/**
 * The analytics doors in the database (T-607, migration 0102): the figures of FR-1201 to FR-1205 and FR-1625 for the
 * event's own team, counts only, with the population, the active-player rule and the economy's arithmetic pinned.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("analytics (database)", () => {
  let f: QuestifyFixture;
  beforeAll(async () => {
    f = await questifyFixture();
  });
  afterAll(async () => {
    await f.close();
  });

  const read = async <T>(name: string, event: string, seat = f.team()): Promise<T> =>
    (await f.run<Door<T>>(seat, `SELECT ${name}($1) AS door`, [event]))[0]?.door as T;
  const participation = (event: string) => read<Participation>("analytics_participation", event);
  const quests = (event: string) => read<QuestsAnswer>("analytics_quests", event);
  const economy = (event: string) => read<Economy>("analytics_economy", event);

  const complete = async (event: string, enrollment: string, quest: string, occurrence = 1) => {
    const [row] = await f.owner<{ id: string }>(
      `INSERT INTO quest_completion (organizer_id, event_id, enrollment_id, quest_id, occurrence, method, idempotency_key)
       SELECT organizer_id, id, $2, $3, $4, 'qr', $5 FROM event WHERE id = $1 RETURNING id`,
      [event, enrollment, quest, occurrence, randomUUID()],
    );
    return row?.id ?? "";
  };
  /** A completion with its points entry, as the ledger writes it; returns the entry the team can remove. */
  const credited = async (event: string, enrollment: string, quest: string, occurrence = 1) => {
    const completion = await complete(event, enrollment, quest, occurrence);
    const [entry] = await f.owner<{ id: string }>(
      `INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta,
                                 completion_id, quest_id, actor)
       SELECT organizer_id, id, $2, 'quest', 10, 10, $3, $4, 'player' FROM event WHERE id = $1 RETURNING id`,
      [event, enrollment, completion, quest],
    );
    return entry?.id ?? "";
  };
  const addQuest = async (
    event: string,
    title: string,
    fields: { category?: string; visible?: boolean; flash?: boolean; type?: string } = {},
  ): Promise<string> => {
    const [row] = await f.owner<{ id: string }>(
      `INSERT INTO quest (event_id, category_id, type, title_en, points, repeat_cap, visible, flash, flash_launched_at,
                          opens_at, closes_at)
       SELECT $1, coalesce($2::uuid, (SELECT id FROM category WHERE event_id = $1 ORDER BY position LIMIT 1)),
              $3, $4, 10, 5, $5, $6, CASE WHEN $6 THEN now() END, CASE WHEN $6 THEN now() END,
              CASE WHEN $6 THEN now() + interval '1 hour' END
       RETURNING id`,
      [
        event,
        fields.category ?? null,
        fields.type ?? "scan_qr",
        title,
        fields.visible ?? true,
        fields.flash ?? false,
      ],
    );
    return row?.id ?? "";
  };
  const addPlayer = async (event: string, via: string | null = null) => {
    const player = await f.newPlayer();
    return f.join(event, player, via);
  };

  const reward = async (event: string, name: string, price: number, stock: number) =>
    (
      await f.owner<{ id: string }>(
        `INSERT INTO reward (event_id, kind, name_en, price, stock_total)
         VALUES ($1, 'experience', $2, $3, $4) RETURNING id`,
        [event, name, price, stock],
      )
    )[0]?.id ?? "";
  const spend = async (player: string, rewardId: string) =>
    (
      await f.asPlayer<{ redemption_id: string }>(player, "SELECT * FROM reserve_reward($1, $2)", [
        rewardId,
        randomUUID(),
      ])
    )[0]?.redemption_id ?? "";
  const funded = async (event: string, points: number) => {
    const player = await f.newPlayer();
    const enrollment = await f.join(event, player);
    await f.earn(event, enrollment, { points });
    return { player, enrollment };
  };

  describe("participation", () => {
    it("shows zeros and no activation for an event nobody joined", async () => {
      const event = await f.newEvent({ phase: "live" });
      expect(await participation(event)).toEqual({
        joined: 0,
        active: 0,
        activation: null,
        returning: 0,
        rehearsal: false,
        unit: "week",
        series: [],
        sources: {
          code: 0,
          qr: 0,
          link: 0,
          public_list: 0,
          invite: 0,
          operator: 0,
          rehearsal: 0,
          other: 0,
        },
      });
    });

    it("counts an active player as one who completed at least one quest, once however many", async () => {
      const event = await f.newEvent({ phase: "live" });
      const stage = await addQuest(event, "Stage");
      const booth = await addQuest(event, "Booth");
      const players = [] as string[];
      for (let i = 0; i < 5; i += 1) players.push(await addPlayer(event));
      await complete(event, players[0] ?? "", stage);
      await complete(event, players[0] ?? "", stage, 2);
      await complete(event, players[0] ?? "", booth);
      await complete(event, players[1] ?? "", booth);
      await complete(event, players[2] ?? "", stage);
      const answer = await participation(event);
      expect(answer).toMatchObject({ joined: 5, active: 3, activation: 60 });
    });

    it("does not count a player whose only completions were removed by the team", async () => {
      const event = await f.newEvent({ phase: "live" });
      const stage = await addQuest(event, "Stage");
      const booth = await addQuest(event, "Booth");
      const removedOnly = await addPlayer(event);
      const removedOne = await addPlayer(event);
      const standing = await addPlayer(event);
      await f.removeEntry(event, await credited(event, removedOnly, stage));
      await f.removeEntry(event, await credited(event, removedOne, stage));
      await credited(event, removedOne, booth);
      await credited(event, standing, stage);
      expect(await participation(event)).toMatchObject({ joined: 3, active: 2, activation: 67 });
    });

    it("keeps a player active when a repeat completion stands after the first was removed", async () => {
      const event = await f.newEvent({ phase: "live" });
      const stage = await addQuest(event, "Stage");
      const player = await addPlayer(event);
      await f.removeEntry(event, await credited(event, player, stage));
      await credited(event, player, stage, 2);
      expect(await participation(event)).toMatchObject({ joined: 1, active: 1, activation: 100 });
    });

    it("rounds the activation rate to a whole percent", async () => {
      const event = await f.newEvent({ phase: "live" });
      const stage = await addQuest(event, "Stage");
      const players = [] as string[];
      for (let i = 0; i < 3; i += 1) players.push(await addPlayer(event));
      await complete(event, players[0] ?? "", stage);
      expect((await participation(event)).activation).toBe(33);
      await complete(event, players[1] ?? "", stage);
      expect((await participation(event)).activation).toBe(67);
    });

    it("splits the joined players by source and the parts add up to the whole", async () => {
      const event = await f.newEvent({ phase: "live" });
      const via = ["code", "code", "qr", "link", "public_list", "invite", "operator", null];
      for (const source of via) await addPlayer(event, source);
      const { joined, sources } = await participation(event);
      expect(sources).toEqual({
        code: 2,
        qr: 1,
        link: 1,
        public_list: 1,
        invite: 1,
        operator: 1,
        rehearsal: 0,
        other: 1,
      });
      expect(Object.values(sources).reduce((sum, count) => sum + count, 0)).toBe(joined);
    });

    it("counts a player who left or was banned, and leaves out pending and declined requests", async () => {
      const event = await f.newEvent({ phase: "live" });
      const states = ["active", "left", "banned", "removed", "pending", "declined"] as const;
      for (const status of states) {
        const enrollment = await addPlayer(event, "code");
        await f.owner("UPDATE enrollment SET status = $2 WHERE id = $1", [enrollment, status]);
      }
      expect((await participation(event)).joined).toBe(4);
    });

    it("marks an event that holds rehearsal accounts, and counts them under their own source", async () => {
      const event = await f.newEvent({ phase: "scheduled" });
      await addPlayer(event, "code");
      expect(await participation(event)).toMatchObject({ rehearsal: false, joined: 1 });
      await addPlayer(event, "rehearsal");
      const answer = await participation(event);
      expect(answer).toMatchObject({ rehearsal: true, joined: 2 });
      expect(answer.sources).toMatchObject({ code: 1, rehearsal: 1 });
    });

    it("counts a returning player once, from two event days with a completion", async () => {
      const event = await f.newEvent({ phase: "live" });
      const stage = await addQuest(event, "Stage");
      const [organizer] = await f.owner<{ organizer_id: string }>(
        "SELECT organizer_id FROM event WHERE id = $1",
        [event],
      );
      const day = async (enrollment: string, date: string, occurrence: number) => {
        await complete(event, enrollment, stage, occurrence);
        await f.owner(
          `INSERT INTO event_streak_day (enrollment_id, day, organizer_id, event_id, days, completion_id)
           SELECT $1, $2::date, $3, $4, 1, max(id) FROM quest_completion WHERE enrollment_id = $1`,
          [enrollment, date, organizer?.organizer_id, event],
        );
      };
      const twice = await addPlayer(event);
      const once = await addPlayer(event);
      const thrice = await addPlayer(event);
      await day(twice, "2026-10-01", 1);
      await day(twice, "2026-10-02", 2);
      await day(once, "2026-10-01", 1);
      await day(thrice, "2026-10-01", 1);
      await day(thrice, "2026-10-02", 2);
      await day(thrice, "2026-10-03", 3);
      expect((await participation(event)).returning).toBe(2);
    });

    it("draws the players over time as a running count in the event's zone", async () => {
      const event = await f.newEvent({ phase: "live" });
      await f.owner("UPDATE event SET timezone = 'Asia/Riyadh' WHERE id = $1", [event]);
      const joinedAt = [
        "2026-10-01T09:05:00Z",
        "2026-10-01T09:50:00Z",
        "2026-10-01T11:00:00Z",
        "2026-10-01T11:10:00Z",
        "2026-10-01T11:20:00Z",
      ];
      for (const at of joinedAt) {
        const enrollment = await addPlayer(event);
        await f.owner("UPDATE enrollment SET joined_at = $2 WHERE id = $1", [enrollment, at]);
      }
      const answer = await participation(event);
      expect(answer.unit).toBe("hour");
      expect(answer.series).toEqual([
        { at: "2026-10-01T12:00", joined: 2 },
        { at: "2026-10-01T14:00", joined: 5 },
      ]);
    });

    it("widens the bucket from hours to days to weeks as the span grows", async () => {
      const event = await f.newEvent({ phase: "live" });
      const first = await addPlayer(event);
      const last = await addPlayer(event);
      await f.owner("UPDATE enrollment SET joined_at = now() - interval '3 days' WHERE id = $1", [
        first,
      ]);
      expect((await participation(event)).unit).toBe("day");
      await f.owner("UPDATE enrollment SET joined_at = now() - interval '100 days' WHERE id = $1", [
        last,
      ]);
      expect((await participation(event)).unit).toBe("week");
    });

    it("answers counts only: no player, enrollment or contact detail", async () => {
      const event = await f.newEvent({ phase: "live" });
      const stage = await addQuest(event, "Stage");
      await complete(event, await addPlayer(event, "qr"), stage);
      const text = JSON.stringify(await participation(event));
      expect(Object.keys(JSON.parse(text) as object).toSorted()).toEqual([
        "activation",
        "active",
        "joined",
        "rehearsal",
        "returning",
        "series",
        "sources",
        "unit",
      ]);
      expect(text).not.toMatch(/@mail|qfy_player|username|enrollment|player_id|device/);
    });
  });

  describe("quests and categories", () => {
    it("counts the players who completed each quest once, not the repeats", async () => {
      const event = await f.newEvent({ phase: "live" });
      const stage = await addQuest(event, "Stage");
      const booth = await addQuest(event, "Booth");
      await f.owner("UPDATE quest SET position = 9 WHERE id = $1", [booth]);
      const a = await addPlayer(event);
      const b = await addPlayer(event);
      await addPlayer(event);
      await complete(event, a, stage);
      await complete(event, a, stage, 2);
      await complete(event, b, stage);
      await complete(event, b, booth);
      const answer = await quests(event);
      expect(answer.joined).toBe(3);
      const [general] = answer.categories;
      expect(general?.quests.map((quest) => quest.done)).toEqual([2, 1]);
    });

    it("leaves out a completion whose award the team removed, and keeps a player whose repeat stands", async () => {
      const event = await f.newEvent({ phase: "live" });
      const stage = await addQuest(event, "Stage");
      const booth = await addQuest(event, "Booth");
      await f.owner("UPDATE quest SET position = 9 WHERE id = $1", [booth]);
      const a = await addPlayer(event);
      const b = await addPlayer(event);
      const c = await addPlayer(event);
      await credited(event, a, stage);
      await f.removeEntry(event, await credited(event, b, stage));
      await f.removeEntry(event, await credited(event, c, stage));
      await credited(event, c, stage, 2);
      await f.removeEntry(event, await credited(event, a, booth));
      const [group] = (await quests(event)).categories;
      expect(group?.quests.map((quest) => quest.done)).toEqual([2, 0]);
    });

    it("lists only visible quests that are not deleted, in the builder's order", async () => {
      const event = await f.newEvent({ phase: "live" });
      const [category] = await f.owner<{ id: string }>(
        "SELECT id FROM category WHERE event_id = $1",
        [event],
      );
      const first = await addQuest(event, "First");
      const hidden = await addQuest(event, "Hidden", { visible: false });
      const second = await addQuest(event, "Second");
      await f.owner("UPDATE quest SET position = 5 WHERE id = $1", [second]);
      await f.owner("UPDATE quest SET position = 1 WHERE id = $1", [first]);
      const [group] = (await quests(event)).categories;
      expect(group?.id).toBe(category?.id);
      expect(group?.quests.map((quest) => quest.id)).toEqual([first, second]);
      expect(group?.quests.map((quest) => quest.id)).not.toContain(hidden);
    });

    it("says which quests take part in a category's order and which a team member skipped", async () => {
      const event = await f.newEvent({ phase: "live" });
      await f.owner("UPDATE category SET order_mode = 'in_order' WHERE event_id = $1", [event]);
      const step = await addQuest(event, "Step");
      const flash = await addQuest(event, "Flash", { flash: true });
      const broken = await addQuest(event, "Broken");
      await f.owner("UPDATE quest SET skipped_at = now(), skipped_by = $2 WHERE id = $1", [
        broken,
        randomUUID(),
      ]);
      const [group] = (await quests(event)).categories;
      expect(group?.inOrder).toBe(true);
      const by = (id: string) => group?.quests.find((quest) => quest.id === id);
      expect(by(step)).toMatchObject({ step: true, skipped: false });
      expect(by(flash)).toMatchObject({ step: false, skipped: false });
      expect(by(broken)).toMatchObject({ step: true, skipped: true });
    });

    it("shows an event without quests as no categories with quests, and zero joined", async () => {
      const event = await f.newEvent({ phase: "live" });
      const answer = await quests(event);
      expect(answer.joined).toBe(0);
      expect(answer.categories.flatMap((category) => category.quests)).toEqual([]);
    });

    it("keeps one event's completions out of another's", async () => {
      const one = await f.newEvent({ phase: "live" });
      const two = await f.newEvent({ phase: "live" });
      const stageOne = await addQuest(one, "Stage");
      await addQuest(two, "Stage");
      await complete(one, await addPlayer(one), stageOne);
      const [group] = (await quests(two)).categories;
      expect(group?.quests.map((quest) => quest.done)).toEqual([0]);
    });
  });

  describe("rewards and points", () => {
    it("shows zeros for an event with no points and no rewards", async () => {
      const event = await f.newEvent({ phase: "live" });
      expect(await economy(event)).toEqual({ earned: 0, spent: 0, unclaimed: 0, rewards: [] });
    });

    it("adds up the points earned, the points spent and the reservations nobody picked up", async () => {
      const event = await f.newEvent({ phase: "live" });
      const hoodie = await reward(event, "Hoodie", 60, 5);
      const mug = await reward(event, "Mug", 20, 5);
      const a = await funded(event, 100);
      const b = await funded(event, 100);
      await funded(event, 50);
      const first = await spend(a.player, hoodie);
      await spend(a.player, mug);
      await spend(b.player, mug);
      await f.owner(
        "UPDATE redemption SET status = 'handed_over', ended_at = now(), ended_by = 'handover', operator_id = $2 WHERE id = $1",
        [first, a.player],
      );
      const answer = await economy(event);
      expect(answer).toMatchObject({ earned: 250, spent: 100, unclaimed: 2 });
      expect(answer.rewards).toEqual([
        expect.objectContaining({ id: mug, redeemed: 2, unclaimed: 2, stockLeft: 3, price: 20 }),
        expect.objectContaining({ id: hoodie, redeemed: 1, unclaimed: 0, stockLeft: 4, price: 60 }),
      ]);
    });

    it("does not count a cancelled reservation as spent or unclaimed, and returns its stock", async () => {
      const event = await f.newEvent({ phase: "live" });
      const mug = await reward(event, "Mug", 20, 5);
      const a = await funded(event, 100);
      const made = await spend(a.player, mug);
      await f.owner(
        "UPDATE redemption SET status = 'cancelled', ended_at = now(), ended_by = 'player' WHERE id = $1",
        [made],
      );
      await f.owner("UPDATE reward SET units_out = 0 WHERE id = $1", [mug]);
      const answer = await economy(event);
      expect(answer).toMatchObject({ earned: 100, spent: 0, unclaimed: 0 });
      expect(answer.rewards[0]).toMatchObject({ redeemed: 0, unclaimed: 0, stockLeft: 5 });
    });

    it("reports the same points earned when a spend lowers the rank as when it does not", async () => {
      const event = await f.newEvent({ phase: "live" });
      await f.owner("UPDATE event SET spend_lowers_rank = true WHERE id = $1", [event]);
      const mug = await reward(event, "Mug", 20, 5);
      const a = await funded(event, 100);
      await spend(a.player, mug);
      const [row] = await f.owner<{ score: string }>("SELECT score FROM enrollment WHERE id = $1", [
        a.enrollment,
      ]);
      expect(row?.score).toBe("80");
      expect(await economy(event)).toMatchObject({ earned: 100, spent: 20 });
    });

    it("adds back only what a purchase made while the event was live took from the score", async () => {
      const event = await f.newEvent({ phase: "live" });
      await f.owner("UPDATE event SET spend_lowers_rank = true WHERE id = $1", [event]);
      const mug = await reward(event, "Mug", 20, 5);
      const hoodie = await reward(event, "Hoodie", 30, 5);
      const a = await funded(event, 100);
      await spend(a.player, mug);
      await f.owner("UPDATE event SET ends_at = now() - interval '1 minute' WHERE id = $1", [
        event,
      ]);
      await spend(a.player, hoodie);
      const [row] = await f.owner<{ score: string; balance: string }>(
        "SELECT score, balance FROM enrollment WHERE id = $1",
        [a.enrollment],
      );
      expect(row).toEqual({ score: "80", balance: "50" });
      expect(await economy(event)).toMatchObject({ earned: 100, spent: 50 });
    });

    it("lists a removed reward only while something stands redeemed from it", async () => {
      const event = await f.newEvent({ phase: "live" });
      const gone = await reward(event, "Gone", 10, 5);
      const kept = await reward(event, "Kept", 10, 5);
      const a = await funded(event, 100);
      await spend(a.player, kept);
      await f.owner("UPDATE reward SET status = 'removed' WHERE id IN ($1, $2)", [gone, kept]);
      const answer = await economy(event);
      expect(answer.rewards.map((one) => one.id)).toEqual([kept]);
      expect(answer.rewards[0]?.removed).toBe(true);
    });
  });

  describe("who may read", () => {
    const doors = [
      "SELECT analytics_participation($1)",
      "SELECT analytics_quests($1)",
      "SELECT analytics_economy($1)",
    ];

    it("refuses another organizer's team, a player and an anonymous caller", async () => {
      const event = await f.newEvent({ phase: "live" });
      for (const sql of doors) {
        const other = f.team(f.ownerA, f.ids.orgB);
        expect(await refusal(f.run(other, sql, [event])), `other team ${sql}`).toBe("AN404");
        const player = await f.newPlayer();
        expect(await refusal(f.run({ playerId: player }, sql, [event])), `player ${sql}`).toBe(
          "AN404",
        );
        expect(await refusal(f.run({}, sql, [event])), `anonymous ${sql}`).toBe("AN404");
        expect(await refusal(f.run(f.team(), sql, [randomUUID()])), `unknown ${sql}`).toBe("AN404");
      }
    });
  });
});
