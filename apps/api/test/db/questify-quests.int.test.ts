import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RequestContext } from "#src/db/context";
import { TEST_DATABASE_URL } from "#test/support/test-db";
import { questifyFixture, type QuestifyFixture } from "#test/support/questify";

type Bilingual = { ar: string; en: string };
type Sync = {
  achievements: { id: string; tier: string }[];
  quests: { id: string; title: Bilingual; xp: number }[];
  levelUp: null | { level: number; title: Bilingual; items: { id: string }[] };
  gems: { earned: number; balance: number };
};
type Campaign = { id: string; status: string; startsAt: string; endsAt: string; name: Bilingual };
type Quest = {
  id: string;
  campaignId: string | null;
  metric: string;
  target: number;
  title: Bilingual;
  xp: number;
  position: number;
  status: string;
};
type Card = {
  id: string;
  metric: string;
  target: number;
  progress: number;
  xp: number;
  done: boolean;
};
type Own = {
  alwaysOn: Card[];
  seasonal: { campaign: { id: string; name: Bilingual; endsAt: string }; quests: Card[] }[];
};

const QUEST = {
  campaignId: null,
  metric: "events",
  target: 1,
  title: { ar: "مهمة", en: "Quest" },
  xp: 50,
  position: 10,
  status: "active",
};
const hours = (n: number) => new Date(Date.now() + n * 3600 * 1000);
const window = (startsAt: Date, endsAt: Date) => ({
  name: { ar: "موسم", en: "Season" },
  startsAt: startsAt.toISOString(),
  endsAt: endsAt.toISOString(),
});

/**
 * Questify quests (T-403b, migration 0066, ADR-278, ADR-280): the catalog and its console doors, the windowed
 * evaluator, one award and one XP entry per (player, quest), the XP row's shape, the freeze and the caps.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("questify quests (database)", () => {
  let f: QuestifyFixture;
  let admin = "";
  beforeAll(async () => {
    f = await questifyFixture();
    const [row] = await f.owner<{ id: string }>(
      "INSERT INTO staff_user (email, password_hash, platform_role) VALUES ('quests@questify.test', 'h', 'admin') RETURNING id",
    );
    admin = row?.id ?? "";
  });
  afterAll(async () => {
    await f.close();
  });

  const seat = (): RequestContext => ({ isAdmin: true, staffUserId: admin });
  const door = async <T>(sql: string, values: unknown[]): Promise<T> =>
    (await f.run<{ r: T }>(seat(), sql, values))[0]?.r as T;
  const saveCampaign = (fields: object, target: string | null = null) =>
    door<Campaign>("SELECT questify_campaign_save($1, $2::jsonb, $3) AS r", [
      target,
      JSON.stringify(fields),
      randomUUID(),
    ]);
  const publish = (id: string) =>
    door<Campaign>("SELECT questify_campaign_publish($1, $2) AS r", [id, randomUUID()]);
  const retireCampaign = (id: string) =>
    door<Campaign>("SELECT questify_campaign_retire($1, $2) AS r", [id, randomUUID()]);
  const saveQuest = (fields: Partial<typeof QUEST> | object, target: string | null = null) =>
    door<Quest>("SELECT questify_quest_save($1, $2::jsonb, $3) AS r", [
      target,
      JSON.stringify({ ...QUEST, ...fields }),
      randomUUID(),
    ]);
  const retireQuest = (id: string) =>
    door<Quest>("SELECT questify_quest_retire($1, $2) AS r", [id, randomUUID()]);
  /** A published campaign with its quests, then its window moved to [since, until) (publishing needs a future start). */
  const seasonal = async (since: Date, until: Date, quests: object[] = [{}]) => {
    const campaign = await saveCampaign(window(hours(1), hours(2)));
    const made: string[] = [];
    for (const quest of quests)
      made.push((await saveQuest({ ...quest, campaignId: campaign.id })).id);
    await publish(campaign.id);
    await f.owner("UPDATE questify_campaign SET starts_at = $2, ends_at = $3 WHERE id = $1", [
      campaign.id,
      since,
      until,
    ]);
    return { campaign: campaign.id, quests: made };
  };
  const sync = async (player: string) =>
    (await f.asPlayer<{ r: Sync }>(player, "SELECT questify_sync() AS r"))[0]?.r as Sync;
  const paid = async (player: string) => (await sync(player)).quests.map((quest) => quest.id);
  const awards = async (player: string) =>
    (
      await f.owner<{ quest_id: string }>(
        "SELECT quest_id FROM questify_award WHERE player_id = $1 ORDER BY id",
        [player],
      )
    ).map((row) => row.quest_id);
  const xpOf = async (player: string) =>
    Number(
      (await f.owner<{ xp: string }>("SELECT xp FROM player_xp WHERE player_id = $1", [player]))[0]
        ?.xp,
    );
  const own = async (player: string) =>
    (await f.asPlayer<{ r: Own | null }>(player, "SELECT own_questify_quests() AS r"))[0]?.r;
  /** One quest credit written at `at` on a new event. */
  const playAt = async (player: string, at: Date) => {
    const event = await f.newEvent();
    await f.earn(event, await f.join(event, player), { at });
  };

  it("seeds three always-on quests and pays the play ones once with their XP, level-up and level items", async () => {
    const seeded = await f.owner<{ id: string; metric: string; target: number; xp: number }>(
      "SELECT id, metric, target, xp FROM questify_quest WHERE campaign_id IS NULL AND status = 'active' ORDER BY position",
    );
    expect(seeded.map((row) => [row.metric, row.target, row.xp])).toEqual([
      ["events", 3, 300],
      ["cities", 2, 300],
      ["interests_set", 1, 100],
    ]);
    const player = await f.newPlayer();
    await f.play(await f.newEvent({ cityId: "sa-riyadh" }), player);
    await f.play(await f.newEvent({ cityId: "sa-jeddah" }), player);
    expect((await sync(player)).quests.map((quest) => quest.id)).toEqual([seeded[1]?.id]);
    await f.play(await f.newEvent(), player);
    const answer = await sync(player);
    expect(answer.quests).toEqual([
      { id: seeded[0]?.id, title: { ar: "شارك في 3 فعاليات", en: "Attend 3 events" }, xp: 300 },
    ]);
    // 3 quest credits of 100 and two awards of 300: 900 XP is level 4; the second award reached it.
    expect(await xpOf(player)).toBe(900);
    expect(answer.levelUp).toMatchObject({ level: 4, title: { en: "Explorer" } });
    expect(answer.levelUp?.items.map((item) => item.id)).toEqual(["level-4"]);
    // Gems (T-404): levels 2 to 4 at 20, two bronze tiers at 10 and the two seeded quests at 25.
    expect(await sync(player)).toEqual({
      achievements: [],
      quests: [],
      levelUp: null,
      gems: { earned: 0, balance: 130 },
      // The daily streak (T-405): the plays above counted today.
      dailyStreak: { days: 1, today: true, next: { days: 3, xp: 50 }, rewards: [] },
    });
    const rows = await f.owner(
      `SELECT x.delta, x.ledger_entry_id, x.quest_id, x.reverses, a.quest_id AS award_quest
       FROM xp_entry x JOIN questify_award a ON a.id = x.questify_award_id
       WHERE x.player_id = $1 AND x.source = 'questify' ORDER BY x.id`,
      [player],
    );
    expect(rows).toEqual([
      {
        delta: 300,
        ledger_entry_id: null,
        quest_id: null,
        reverses: null,
        award_quest: seeded[1]?.id,
      },
      {
        delta: 300,
        ledger_entry_id: null,
        quest_id: null,
        reverses: null,
        award_quest: seeded[0]?.id,
      },
    ]);
    const items = await f.owner<{ source_level: number }>(
      "SELECT source_level FROM player_item WHERE player_id = $1 ORDER BY source_level",
      [player],
    );
    expect(items.map((row) => row.source_level)).toEqual([2, 3, 4]);
  });

  it("writes one award when two syncs cross; only the first reports it", async () => {
    const quest = await saveQuest({ metric: "quests", target: 2, xp: 40 });
    const player = await f.newPlayer();
    await f.play(await f.newEvent(), player, 2);
    const call = { context: { playerId: player }, sql: "SELECT questify_sync() AS r" };
    const outcome = await f.crossed(call, call);
    expect(outcome.waited).toBe(true);
    expect((outcome.first as { r: Sync }).r.quests.map((q) => q.id)).toEqual([quest.id]);
    expect((outcome.second as { r: Sync }).r).toEqual({
      achievements: [],
      quests: [],
      levelUp: null,
      gems: { earned: 0, balance: 30 },
      // The daily streak (T-405): the plays above counted today.
      dailyStreak: { days: 1, today: true, next: { days: 3, xp: 50 }, rewards: [] },
    });
    expect(await awards(player)).toEqual([quest.id]);
    await retireQuest(quest.id);
  });

  it("pays nothing from a draft or retired quest, or a draft or retired campaign", async () => {
    const draft = await saveQuest({ status: "draft" });
    const retired = await saveQuest({});
    await retireQuest(retired.id);
    const paused = await saveCampaign(window(hours(-48), hours(48)));
    const inDraft = await saveQuest({ campaignId: paused.id });
    const gone = await seasonal(hours(-48), hours(48));
    await retireCampaign(gone.campaign);
    const control = await saveQuest({ xp: 20 });
    const player = await f.newPlayer();
    await f.play(await f.newEvent(), player);
    expect(await paid(player)).toEqual([control.id]);
    expect(await awards(player)).toEqual([control.id]);
    expect([draft.id, retired.id, inDraft.id, ...gone.quests]).not.toContain(control.id);
    await retireQuest(control.id);
  });

  it("counts a seasonal quest only on plays whose ledger entry falls inside [starts_at, ends_at)", async () => {
    const since = hours(-48);
    const until = hours(-1);
    const { quests } = await seasonal(since, until, [{ metric: "events", target: 2 }]);
    const player = await f.newPlayer();
    await playAt(player, new Date(since.getTime() - 1000));
    await playAt(player, until);
    expect(await paid(player)).not.toContain(quests[0]);
    await playAt(player, since);
    expect(await paid(player)).not.toContain(quests[0]);
    await playAt(player, new Date(until.getTime() - 1000));
    expect(await paid(player)).toContain(quests[0]);
    expect(await awards(player)).toContain(quests[0]);
  });

  it("still pays an in-window play up to 3 days after the end, and not after", async () => {
    const grace = 3 * 24;
    const late = await seasonal(hours(-grace - 24), hours(-grace + 0.05));
    const closed = await seasonal(hours(-grace - 24), hours(-grace - 0.05));
    const player = await f.newPlayer();
    await playAt(player, hours(-grace - 12));
    const got = await paid(player);
    expect(got).toContain(late.quests[0]);
    expect(got).not.toContain(closed.quests[0]);
  });

  it("offers a campaign only while it runs, with progress inside its window and done once paid", async () => {
    const running = await seasonal(hours(-24), hours(24), [
      { metric: "events", target: 2, xp: 75, position: 1 },
    ]);
    await seasonal(hours(-48), hours(-1));
    const soon = await saveCampaign(window(hours(1), hours(5)));
    await saveQuest({ campaignId: soon.id });
    await publish(soon.id);
    const player = await f.newPlayer();
    await playAt(player, hours(-30));
    await playAt(player, hours(-2));
    const before = await own(player);
    expect(
      before?.alwaysOn.map((card) => [card.metric, card.target, card.progress, card.done]),
    ).toEqual([
      ["events", 3, 2, false],
      ["cities", 2, 0, false],
      ["interests_set", 1, 0, false],
    ]);
    expect(before?.seasonal).toEqual([
      {
        campaign: {
          id: running.campaign,
          name: { ar: "موسم", en: "Season" },
          endsAt: expect.any(String),
        },
        quests: [
          {
            id: running.quests[0],
            title: QUEST.title,
            metric: "events",
            target: 2,
            progress: 1,
            xp: 75,
            gems: 0,
            done: false,
          },
        ],
      },
    ]);
    await playAt(player, hours(-1));
    expect(await paid(player)).toEqual(expect.arrayContaining([running.quests[0]]));
    expect((await own(player))?.seasonal[0]?.quests[0]).toMatchObject({ progress: 2, done: true });
    expect(await f.run({}, "SELECT own_questify_quests() AS r")).toEqual([{ r: null }]);
    expect(await f.run(f.team(), "SELECT own_questify_quests() AS r")).toEqual([{ r: null }]);
    await retireCampaign(running.campaign);
    expect((await own(player))?.seasonal).toEqual([]);
  });

  it("publishes only before the start and keeps a published window's rules", async () => {
    const past = await saveCampaign(window(hours(-1), hours(5)));
    await expect(publish(past.id)).rejects.toMatchObject({ code: "QY409", detail: "start_passed" });
    const made = await saveCampaign(window(hours(1), hours(5)));
    expect(made.status).toBe("draft");
    expect((await publish(made.id)).status).toBe("published");
    expect((await publish(made.id)).status).toBe("published");
    await expect(saveCampaign(window(hours(-1), hours(5)), made.id)).rejects.toMatchObject({
      code: "QY409",
      detail: "start_passed",
    });
    await saveCampaign(window(hours(2), hours(5)), made.id);
    const begun = hours(-1);
    await f.owner("UPDATE questify_campaign SET starts_at = $2 WHERE id = $1", [made.id, begun]);
    const started = { ...window(hours(-1), hours(5)), startsAt: hours(-2).toISOString() };
    await expect(saveCampaign(started, made.id)).rejects.toMatchObject({
      code: "QY409",
      detail: "started",
    });
    const fixedStart = begun.toISOString();
    await expect(
      saveCampaign({ ...window(hours(0), hours(4)), startsAt: fixedStart }, made.id),
    ).rejects.toMatchObject({ code: "QY409", detail: "ends_earlier" });
    const later = await saveCampaign(
      { ...window(hours(0), hours(9)), startsAt: fixedStart },
      made.id,
    );
    expect(new Date(later.endsAt).getTime()).toBeGreaterThan(hours(8).getTime());
    const over = hours(-0.5);
    await f.owner("UPDATE questify_campaign SET ends_at = $2 WHERE id = $1", [made.id, over]);
    const fixed = { startsAt: fixedStart, endsAt: over.toISOString() };
    await expect(
      saveCampaign(
        { ...fixed, name: { ar: "موسم", en: "Season" }, endsAt: hours(9).toISOString() },
        made.id,
      ),
    ).rejects.toMatchObject({ code: "QY409", detail: "ended" });
    const renamed = await saveCampaign({ ...fixed, name: { ar: "الشتاء", en: "Winter" } }, made.id);
    expect(renamed.name).toEqual({ ar: "الشتاء", en: "Winter" });
    expect((await retireCampaign(made.id)).status).toBe("retired");
    expect((await retireCampaign(made.id)).status).toBe("retired");
    await expect(saveCampaign(window(hours(1), hours(5)), made.id)).rejects.toMatchObject({
      code: "QY409",
      detail: "retired",
    });
    await expect(publish(made.id)).rejects.toMatchObject({ code: "QY409", detail: "retired" });
    for (const sql of [
      "SELECT questify_campaign_publish($1, $2)",
      "SELECT questify_campaign_retire($1, $2)",
      "SELECT questify_quest_retire($1, $2)",
    ]) {
      await expect(f.run(seat(), sql, [randomUUID(), randomUUID()])).rejects.toMatchObject({
        code: "QY404",
      });
    }
  });

  it("fixes a quest's condition once it can pay; title, xp and order still change; xp pays later awards", async () => {
    const quest = await saveQuest({ status: "draft", metric: "events", target: 4 });
    const edited = await saveQuest({ status: "draft", metric: "quests", target: 3 }, quest.id);
    expect([edited.metric, edited.target]).toEqual(["quests", 3]);
    await saveQuest({ metric: "quests", target: 3 }, quest.id);
    for (const change of [{ target: 4 }, { metric: "events" }, { status: "draft" }]) {
      await expect(
        saveQuest({ metric: "quests", target: 3, ...change }, quest.id),
      ).rejects.toMatchObject({
        code: "QY409",
        detail: "frozen",
      });
    }
    const renamed = await saveQuest(
      { metric: "quests", target: 3, title: { ar: "اجمع", en: "Collect" }, position: 3, xp: 60 },
      quest.id,
    );
    expect(renamed).toMatchObject({
      title: { en: "Collect" },
      position: 3,
      xp: 60,
      status: "active",
    });
    const first = await f.newPlayer();
    await f.play(await f.newEvent(), first, 3);
    expect(await paid(first)).toEqual([quest.id]);
    await saveQuest({ metric: "quests", target: 3, xp: 90 }, quest.id);
    const second = await f.newPlayer();
    await f.play(await f.newEvent(), second, 3);
    expect(await paid(second)).toEqual([quest.id]);
    const deltas = await f.owner<{ delta: number }>(
      `SELECT x.delta FROM xp_entry x JOIN questify_award a ON a.id = x.questify_award_id
       WHERE a.quest_id = $1 ORDER BY x.id`,
      [quest.id],
    );
    expect(deltas.map((row) => row.delta)).toEqual([60, 90]);

    const campaign = await saveCampaign(window(hours(1), hours(5)));
    const other = await saveCampaign(window(hours(1), hours(5)));
    const seasonQuest = await saveQuest({ campaignId: campaign.id, target: 2 });
    expect((await saveQuest({ target: 5, campaignId: other.id }, seasonQuest.id)).campaignId).toBe(
      campaign.id,
    );
    await publish(campaign.id);
    await expect(saveQuest({ target: 6 }, seasonQuest.id)).rejects.toMatchObject({
      code: "QY409",
      detail: "frozen",
    });
    expect((await saveQuest({ target: 5, xp: 99 }, seasonQuest.id)).xp).toBe(99);
    expect((await retireQuest(quest.id)).status).toBe("retired");
    expect((await retireQuest(quest.id)).status).toBe("retired");
    await expect(saveQuest({ metric: "quests", target: 3 }, quest.id)).rejects.toMatchObject({
      code: "QY409",
      detail: "retired",
    });
    await expect(saveQuest({}, randomUUID())).rejects.toMatchObject({ code: "QY404" });
  });

  it("never reverses a Questify award when a removal takes a quest's XP back", async () => {
    const quest = await saveQuest({ metric: "quests", target: 1, xp: 50 });
    const player = await f.newPlayer();
    const event = await f.newEvent();
    const entry = await f.earn(event, await f.join(event, player));
    expect(await paid(player)).toEqual([quest.id]);
    expect(await xpOf(player)).toBe(150);
    await f.removeEntry(event, entry);
    expect(await xpOf(player)).toBe(50);
    const rows = await f.owner<{ source: string; delta: number }>(
      "SELECT source, delta FROM xp_entry WHERE player_id = $1 ORDER BY id",
      [player],
    );
    expect(rows).toEqual([
      { source: "quest", delta: 100 },
      { source: "questify", delta: 50 },
      { source: "removal", delta: -100 },
    ]);
    expect(await paid(player)).toEqual([]);
    expect(await awards(player)).toEqual([quest.id]);
    await retireQuest(quest.id);
  });

  it("keeps each XP source's shape", async () => {
    const quest = await saveQuest({ status: "draft" });
    const player = await f.newPlayer();
    const event = await f.newEvent();
    const ledger = await f.earn(event, await f.join(event, player));
    const [credit] = await f.owner<{ id: string; quest_id: string }>(
      "SELECT id, quest_id FROM xp_entry WHERE ledger_entry_id = $1",
      [ledger],
    );
    const [award] = await f.owner<{ id: string }>(
      "INSERT INTO questify_award (player_id, quest_id) VALUES ($1, $2) RETURNING id",
      [player, quest.id],
    );
    const insert = (columns: string, values: unknown[]) =>
      f.owner(
        `INSERT INTO xp_entry (player_id, ${columns}) VALUES ($1, ${values.map((_, i) => `$${i + 2}`).join(", ")})`,
        [player, ...values],
      );
    const shapes: [string, unknown[]][] = [
      ["delta, source, questify_award_id, ledger_entry_id", [5, "questify", award?.id, ledger]],
      ["delta, source, questify_award_id, quest_id", [5, "questify", award?.id, credit?.quest_id]],
      ["delta, source, questify_award_id, reverses", [5, "questify", award?.id, credit?.id]],
      ["delta, source, questify_award_id", [0, "questify", award?.id]],
      ["delta, source", [5, "questify"]],
      ["delta, source, quest_id", [5, "quest", credit?.quest_id]],
      [
        "delta, source, ledger_entry_id, quest_id, questify_award_id",
        [5, "quest", ledger, randomUUID(), award?.id],
      ],
      ["delta, source, ledger_entry_id, reverses", [-5, "removal", ledger, credit?.id]],
      ["delta, source, questify_award_id", [5, "gift", award?.id]],
    ];
    for (const [columns, values] of shapes) {
      await expect(insert(columns, values), columns).rejects.toMatchObject({ code: "23514" });
    }
    await insert("delta, source, questify_award_id", [5, "questify", award?.id]);
    await expect(
      insert("delta, source, questify_award_id", [5, "questify", award?.id]),
    ).rejects.toMatchObject({
      code: "23505",
    });
    await retireQuest(quest.id);
  });

  it("caps quests per campaign at 20 and always-on quests at 50, retired ones not counted", async () => {
    const campaign = await saveCampaign(window(hours(1), hours(5)));
    const made: string[] = [];
    for (let i = 0; i < 20; i += 1)
      made.push((await saveQuest({ campaignId: campaign.id, status: "draft" })).id);
    await expect(saveQuest({ campaignId: campaign.id })).rejects.toMatchObject({
      code: "QY409",
      detail: "too_many",
    });
    await retireQuest(made[0] ?? "");
    await saveQuest({ campaignId: campaign.id, status: "draft" });
    const [open] = await f.owner<{ n: number }>(
      "SELECT count(*)::integer AS n FROM questify_quest WHERE campaign_id IS NULL AND status <> 'retired'",
    );
    const drafts: string[] = [];
    for (let i = open?.n ?? 0; i < 50; i += 1)
      drafts.push((await saveQuest({ status: "draft" })).id);
    await expect(saveQuest({ status: "draft" })).rejects.toMatchObject({
      code: "QY409",
      detail: "too_many",
    });
    for (const id of drafts) await retireQuest(id);
  });

  it("refuses bad names, titles and shapes, an unknown campaign and a closed one", async () => {
    for (const name of [
      { ar: "موسم", en: "Sea\u202Eson" },
      { ar: "مو\u2066سم", en: "Season" },
      { ar: "موسم", en: "Line\nbreak" },
      { ar: " ", en: "Season" },
      { ar: "موسم", en: "x".repeat(81) },
    ]) {
      await expect(saveCampaign({ ...window(hours(1), hours(2)), name })).rejects.toMatchObject({
        code: "23514",
      });
    }
    await expect(saveCampaign(window(hours(2), hours(1)))).rejects.toMatchObject({ code: "23514" });
    for (const fields of [
      { title: { ar: "مهمة", en: "Bad\u2028title" } },
      { metric: "gems" },
      { target: 0 },
      { target: 1001 },
      { xp: 0 },
      { xp: 10001 },
      { position: 0 },
    ]) {
      await expect(saveQuest({ status: "draft", ...fields })).rejects.toMatchObject({
        code: "23514",
      });
    }
    for (const status of ["retired", null, "paused"]) {
      await expect(saveQuest({ status })).rejects.toMatchObject({
        code: "QY422",
        detail: "status",
      });
    }
    await expect(saveQuest({ campaignId: randomUUID() })).rejects.toMatchObject({
      code: "QY422",
      detail: "campaignId",
    });
    const ended = await seasonal(hours(-5), hours(-1));
    const retired = await saveCampaign(window(hours(1), hours(2)));
    await retireCampaign(retired.id);
    for (const campaignId of [ended.campaign, retired.id]) {
      await expect(saveQuest({ campaignId })).rejects.toMatchObject({
        code: "QY409",
        detail: "campaign_closed",
      });
    }
    await expect(saveQuest({ target: 9 }, ended.quests[0] ?? "")).rejects.toMatchObject({
      code: "QY409",
      detail: "campaign_closed",
    });
    // A new quest counts plays from its campaign's start, so a running campaign takes none; its own quests still edit.
    const running = await seasonal(hours(-1), hours(5));
    await expect(saveQuest({ campaignId: running.campaign })).rejects.toMatchObject({
      code: "QY409",
      detail: "started",
    });
    expect((await saveQuest({ xp: 70 }, running.quests[0] ?? "")).xp).toBe(70);
    await retireCampaign(running.campaign);
  });

  it("lets only an active platform admin run a console door, and audits each write with ids and field names", async () => {
    const [disabled] = await f.owner<{ id: string }>(
      "INSERT INTO staff_user (email, password_hash, platform_role, status) VALUES ('gone@questify.test', 'h', 'admin', 'disabled') RETURNING id",
    );
    const player = await f.newPlayer();
    const seats: RequestContext[] = [
      { playerId: player },
      f.team(),
      { deviceId: randomUUID() },
      {},
      { staffUserId: admin },
      { isAdmin: true, staffUserId: disabled?.id ?? "" },
    ];
    const target = randomUUID();
    const calls: [string, unknown[]][] = [
      ["SELECT questify_admin_list()", []],
      [
        "SELECT questify_campaign_save(NULL, $1::jsonb, $2)",
        [JSON.stringify(window(hours(1), hours(2))), target],
      ],
      ["SELECT questify_campaign_publish($1, $2)", [target, target]],
      ["SELECT questify_campaign_retire($1, $2)", [target, target]],
      ["SELECT questify_quest_save(NULL, $1::jsonb, $2)", [JSON.stringify(QUEST), target]],
      ["SELECT questify_quest_retire($1, $2)", [target, target]],
    ];
    for (const context of seats) {
      for (const [sql, values] of calls) {
        await expect(f.run(context, sql, values), sql).rejects.toMatchObject({ code: "QY403" });
      }
    }

    const request = randomUUID();
    const start = hours(1);
    const made = await door<Campaign>("SELECT questify_campaign_save(NULL, $1::jsonb, $2) AS r", [
      JSON.stringify(window(start, hours(3))),
      request,
    ]);
    await saveCampaign(window(start, hours(4)), made.id);
    await publish(made.id);
    await publish(made.id);
    const quest = await saveQuest({ campaignId: made.id, status: "draft" });
    await saveQuest({ title: { ar: "جديد", en: "New" }, status: "draft" }, quest.id);
    await retireQuest(quest.id);
    await retireCampaign(made.id);
    const audit = await f.owner(
      `SELECT actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, after
       FROM audit_log WHERE target_id IN ($1, $2) ORDER BY id`,
      [made.id, quest.id],
    );
    const by = { actor_type: "admin", actor_id: admin, organizer_id: null, event_id: null };
    const onCampaign = { ...by, target_type: "questify_campaign", target_id: made.id };
    const onQuest = { ...by, target_type: "questify_quest", target_id: quest.id };
    expect(audit).toEqual([
      {
        ...onCampaign,
        action: "questify.campaign_created",
        after: { fields: ["name", "startsAt", "endsAt"] },
      },
      { ...onCampaign, action: "questify.campaign_updated", after: { fields: ["endsAt"] } },
      { ...onCampaign, action: "questify.campaign_published", after: { status: "published" } },
      {
        ...onQuest,
        action: "questify.quest_created",
        after: {
          fields: ["metric", "target", "title", "xp", "gems", "position", "status", "campaignId"],
        },
      },
      { ...onQuest, action: "questify.quest_updated", after: { fields: ["title"] } },
      { ...onQuest, action: "questify.quest_retired", after: { status: "retired" } },
      { ...onCampaign, action: "questify.campaign_retired", after: { status: "retired" } },
    ]);
    const [first] = await f.owner<{ request_id: string }>(
      "SELECT request_id FROM audit_log WHERE target_id = $1 ORDER BY id LIMIT 1",
      [made.id],
    );
    expect(first?.request_id).toBe(request);
    const list = await door<{ alwaysOn: Quest[]; campaigns: (Campaign & { quests: Quest[] })[] }>(
      "SELECT questify_admin_list() AS r",
      [],
    );
    expect(list.alwaysOn.length).toBeGreaterThanOrEqual(3);
    expect(list.campaigns.find((row) => row.id === made.id)).toMatchObject({
      status: "retired",
      quests: [{ id: quest.id, status: "retired", title: { en: "New" } }],
    });
  });

  it.each(["erase-first", "sync-first"])(
    "crosses erasure while paying a quest without a deadlock; the award stays on the tombstone: %s",
    async (order) => {
      const quest = await saveQuest({ metric: "quests", target: 1, xp: 150 });
      const player = await f.newPlayer();
      await f.play(await f.newEvent(), player);
      const erase = {
        context: { playerId: player },
        sql: "SELECT * FROM erase_player($1, true, $2)",
        values: [await f.deletionToken(player), randomUUID()],
      };
      const call = { context: { playerId: player }, sql: "SELECT questify_sync() AS r" };
      const outcome =
        order === "erase-first" ? await f.crossed(erase, call) : await f.crossed(call, erase);
      expect(outcome.waited).toBe(true);
      if (order === "erase-first") {
        expect(outcome.second).toMatchObject({ code: "PI401" });
        expect(await awards(player)).toEqual([]);
      } else {
        expect(outcome.second).not.toBeInstanceOf(Error);
        expect(await awards(player)).toEqual([quest.id]);
        const kept = await f.owner(
          "SELECT 1 FROM xp_entry WHERE player_id = $1 AND source = 'questify'",
          [player],
        );
        expect(kept).toHaveLength(1);
      }
      await retireQuest(quest.id);
    },
  );

  it.each(["completion-first", "sync-first"])(
    "crosses a completion while paying a quest without a deadlock: %s",
    async (order) => {
      const quest = await saveQuest({ metric: "quests", target: 1, xp: 120 });
      const player = await f.newPlayer();
      await f.play(await f.newEvent(), player);
      const live = await f.newEvent({ phase: "live" });
      await f.join(live, player);
      const [code] = await f.owner<{ id: string }>(
        `INSERT INTO quest (event_id, category_id, type, title_en, points, type_config)
         SELECT $1, id, 'enter_code', 'Code', 10, '{"code":"ABC"}' FROM category WHERE event_id = $1 RETURNING id`,
        [live],
      );
      const complete = {
        context: { playerId: player },
        sql: "SELECT * FROM complete_quest($1, 'code', NULL, 'ABC', $2, NULL)",
        values: [code?.id, randomUUID()],
      };
      const call = { context: { playerId: player }, sql: "SELECT questify_sync() AS r" };
      const outcome =
        order === "completion-first"
          ? await f.crossed(complete, call)
          : await f.crossed(call, complete);
      expect(outcome.waited).toBe(true);
      expect(outcome.second).not.toBeInstanceOf(Error);
      expect(await awards(player)).toEqual([quest.id]);
      expect(await xpOf(player)).toBe(320);
      await retireQuest(quest.id);
    },
  );

  it("keeps the tables and helpers closed and awards append-only for every role", async () => {
    const quest = await saveQuest({ xp: 10 });
    const player = await f.newPlayer();
    await f.play(await f.newEvent(), player);
    await sync(player);
    for (const table of ["questify_campaign", "questify_quest", "questify_award"]) {
      for (const sql of [`SELECT * FROM ${table}`, `DELETE FROM ${table}`]) {
        await expect(f.asPlayer(player, sql), sql).rejects.toThrow(/permission denied/);
      }
    }
    for (const sql of [
      "SELECT * FROM questify_due(gen_random_uuid())",
      "SELECT questify_level_up(gen_random_uuid(), '{}')",
      "SELECT questify_admin()",
      "SELECT questify_home(NULL)",
      "SELECT * FROM standing_credits(gen_random_uuid(), NULL, NULL)",
      "SELECT * FROM player_metrics(gen_random_uuid(), NULL, NULL)",
      "SELECT questify_audit(NULL, 'x', 'y', NULL, NULL, NULL)",
    ]) {
      await expect(f.asPlayer(player, sql), sql).rejects.toThrow(/permission denied/);
    }
    for (const sql of [
      "UPDATE questify_award SET earned_at = now() WHERE player_id = $1",
      "DELETE FROM questify_award WHERE player_id = $1",
    ]) {
      await expect(f.owner(sql, [player])).rejects.toThrow(/never be changed/);
    }
    // xp_entry points at the awards, so a plain TRUNCATE is refused by its key; CASCADE meets the triggers.
    await expect(f.owner("TRUNCATE questify_award CASCADE")).rejects.toThrow(/never be changed/);
    expect(await awards(player)).toContain(quest.id);
    await retireQuest(quest.id);
  });

  /** "Set your interests" (T-407c, migration 0071, ADR-320): a lifetime state, met once one interest is chosen. */
  const choose = (player: string, interests: string[], city: string | null = null) =>
    f.asPlayer(player, "SELECT set_preferences($1, $2::text[]) AS r", [city, interests]);
  const SAVE = "SELECT set_preferences(NULL, ARRAY['music']) AS r";
  const interestsQuest = async () =>
    (
      await f.owner<{ id: string }>(
        "SELECT id FROM questify_quest WHERE metric = 'interests_set' AND created_by IS NULL",
      )
    )[0]?.id ?? "";
  const card = async (player: string) =>
    (await own(player))?.alwaysOn.find((one) => one.metric === "interests_set");
  const gemsFor = async (player: string, quest: string) =>
    (
      await f.owner<{ delta: number }>(
        `SELECT g.delta FROM gem_entry g JOIN questify_award a ON a.id = g.questify_award_id
           WHERE a.player_id = $1 AND a.quest_id = $2`,
        [player, quest],
      )
    ).map((row) => row.delta);
  const xpRows = async (player: string, quest: string) =>
    (
      await f.owner<{ delta: number }>(
        `SELECT x.delta FROM xp_entry x JOIN questify_award a ON a.id = x.questify_award_id
           WHERE a.player_id = $1 AND a.quest_id = $2`,
        [player, quest],
      )
    ).map((row) => row.delta);

  const insertInterests = (campaign: string | null, target: number) =>
    f.owner(
      `INSERT INTO questify_quest (campaign_id, metric, target, title_ar, title_en, xp)
         VALUES ($1, 'interests_set', $2, 'مهمة', 'Quest', 10)`,
      [campaign, target],
    );
  describe("set your interests (T-407c)", () => {
    it("is seeded as one active always-on quest: target 1, 100 XP, 10 gems, third in line", async () => {
      expect(
        await f.owner(
          `SELECT campaign_id, target, title_ar, title_en, xp, gems, position, status FROM questify_quest
           WHERE metric = 'interests_set'`,
        ),
      ).toEqual([
        {
          campaign_id: null,
          target: 1,
          title_ar: "اختر اهتماماتك",
          title_en: "Set your interests",
          xp: 100,
          gems: 10,
          position: 3,
          status: "active",
        },
      ]);
    });

    it("pays nothing with no preference row, an empty list or a city alone", async () => {
      const quest = await interestsQuest();
      const none = await f.newPlayer();
      const empty = await f.newPlayer();
      await choose(empty, []);
      const city = await f.newPlayer();
      await choose(city, [], "sa-riyadh");
      for (const player of [none, empty, city]) {
        expect(await card(player)).toMatchObject({ target: 1, progress: 0, done: false });
        expect(await paid(player)).toEqual([]);
        expect(await awards(player)).not.toContain(quest);
      }
    });

    it("pays once for one interest: one award, one XP entry of 100 and 10 gems; a replay pays nothing", async () => {
      const quest = await interestsQuest();
      const player = await f.newPlayer();
      await choose(player, ["sport"]);
      expect(await card(player)).toMatchObject({ progress: 1, done: false });
      const answer = await sync(player);
      expect(answer.quests).toEqual([
        { id: quest, title: { ar: "اختر اهتماماتك", en: "Set your interests" }, xp: 100 },
      ]);
      expect(await xpOf(player)).toBe(100);
      expect(await xpRows(player, quest)).toEqual([100]);
      expect(await gemsFor(player, quest)).toEqual([10]);
      expect(await card(player)).toMatchObject({ progress: 1, done: true });
      await choose(player, ["sport", "music", "tech"]);
      expect(await paid(player)).toEqual([]);
      expect(await awards(player)).toEqual([quest]);
      expect(await xpRows(player, quest)).toEqual([100]);
    });

    it("writes one award, XP entry and gem entry when two syncs cross", async () => {
      const quest = await interestsQuest();
      const player = await f.newPlayer();
      await choose(player, ["food"]);
      const call = { context: { playerId: player }, sql: "SELECT questify_sync() AS r" };
      const outcome = await f.crossed(call, call);
      expect(outcome.waited).toBe(true);
      expect((outcome.first as { r: Sync }).r.quests.map((one) => one.id)).toEqual([quest]);
      expect((outcome.second as { r: Sync }).r.quests).toEqual([]);
      expect(await awards(player)).toEqual([quest]);
      expect(await xpRows(player, quest)).toEqual([100]);
      expect(await gemsFor(player, quest)).toEqual([10]);
    });

    it("never makes a sync wait on a preference save held open; the save counts once committed", async () => {
      const quest = await interestsQuest();
      const player = await f.newPlayer();
      const save = { context: { playerId: player }, sql: SAVE };
      const call = { context: { playerId: player }, sql: "SELECT questify_sync() AS r" };
      const outcome = await f.crossed(save, call);
      expect(outcome.waited).toBe(false);
      expect((outcome.second as { r: Sync }).r.quests).toEqual([]);
      expect(await paid(player)).toEqual([quest]);
    });

    it("never makes a preference save wait on a sync held open on player_xp", async () => {
      const quest = await interestsQuest();
      const player = await f.newPlayer();
      await choose(player, ["art"]);
      const call = { context: { playerId: player }, sql: "SELECT questify_sync() AS r" };
      const save = { context: { playerId: player }, sql: SAVE };
      const outcome = await f.crossed(call, save);
      expect(outcome.waited).toBe(false);
      expect((outcome.first as { r: Sync }).r.quests.map((one) => one.id)).toEqual([quest]);
      expect(outcome.second).toEqual({ r: { cityId: null, interests: ["music"] } });
      expect(await awards(player)).toEqual([quest]);
    });

    it("keeps the award when interests are cleared, and pays nothing for a choice cleared before a sync", async () => {
      const quest = await interestsQuest();
      const kept = await f.newPlayer();
      await choose(kept, ["travel"]);
      await sync(kept);
      await choose(kept, []);
      expect(await card(kept)).toMatchObject({ progress: 0, done: true });
      expect(await paid(kept)).toEqual([]);
      await choose(kept, ["art"]);
      expect(await paid(kept)).toEqual([]);
      expect(await awards(kept)).toEqual([quest]);
      expect(await xpRows(kept, quest)).toEqual([100]);
      expect(await gemsFor(kept, quest)).toEqual([10]);
      const undone = await f.newPlayer();
      await choose(undone, ["travel"]);
      await choose(undone, []);
      expect(await paid(undone)).toEqual([]);
      expect(await awards(undone)).toEqual([]);
    });

    it("never counts player B's interests for player A", async () => {
      const a = await f.newPlayer();
      const b = await f.newPlayer();
      await choose(b, ["gaming", "music"]);
      expect(await card(a)).toMatchObject({ progress: 0, done: false });
      expect(await paid(a)).toEqual([]);
      expect(await card(b)).toMatchObject({ progress: 1 });
    });

    it("is a lifetime metric only, and never reaches the achievements", async () => {
      const player = await f.newPlayer();
      await choose(player, ["sport"]);
      const metrics = async (since: Date | null, until: Date | null) =>
        (
          await f.owner<{ metric: string; value: number }>(
            "SELECT metric, value FROM player_metrics($1, $2, $3)",
            [player, since, until],
          )
        ).map((row) => [row.metric, row.value]);
      expect(await metrics(null, null)).toContainEqual(["interests_set", 1]);
      expect((await metrics(hours(-1), hours(1))).map(([metric]) => metric)).toEqual([
        "events",
        "quests",
        "cities",
      ]);
      const achievements = await f.asPlayer<{ r: { id: string }[] }>(
        player,
        "SELECT own_achievements() AS r",
      );
      expect(achievements[0]?.r).toHaveLength(5);
    });

    it("refuses the metric in a campaign or with another target, at the table and the console door", async () => {
      const shape = { code: "23514", constraint: "questify_quest_interests_shape" };
      const campaign = await saveCampaign(window(hours(1), hours(2)));
      await expect(insertInterests(null, 2)).rejects.toMatchObject(shape);
      await expect(insertInterests(campaign.id, 1)).rejects.toMatchObject(shape);
      await expect(
        saveQuest({ metric: "interests_set", target: 1, campaignId: campaign.id, status: "draft" }),
      ).rejects.toMatchObject(shape);
      const draft = await saveQuest({ campaignId: campaign.id, status: "draft" });
      await expect(
        saveQuest({ metric: "interests_set", target: 1, status: "draft" }, draft.id),
      ).rejects.toMatchObject(shape);
      await expect(
        saveQuest({ metric: "interests_set", target: 2, status: "draft" }),
      ).rejects.toMatchObject(shape);
      await retireCampaign(campaign.id);
    });

    it("refuses a player who is not active and writes nothing", async () => {
      const player = await f.newPlayer();
      await choose(player, ["sport"]);
      await f.owner("UPDATE player SET status = 'banned' WHERE id = $1", [player]);
      await expect(sync(player)).rejects.toMatchObject({ code: "PI401" });
      expect(await awards(player)).toEqual([]);
    });
  });
});
