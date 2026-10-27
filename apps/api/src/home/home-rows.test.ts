import { describe, expect, it } from "vitest";
import { memberActivity, memberQuests, playStatus, readHome } from "#src/home/home";
import { createFirstBonusCache } from "#src/quests/first-bonus";
import type { ConfigResult, SettingsService } from "#src/settings/service";
import { fakePool } from "#test/support/fake-pool";

const PLAYER = "11111111-1111-4111-8111-111111111111";
const EVENT = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-11-01T12:00:00Z");

/** A configuration that names no feature: every switch the home reads counts as on. */
const settings = {
  forEvent: async (): Promise<ConfigResult> =>
    ({ kind: "ok", config: { features: {} }, etag: "x" }) as unknown as ConfigResult,
} as unknown as SettingsService;

const standing = (fields: Record<string, unknown> = {}) => ({
  status: "active",
  waitlisted: false,
  score: "40",
  balance: "40",
  name_ar: null,
  name_en: "Fest",
  venue_ar: null,
  venue_en: null,
  starts_at: null,
  ends_at: null,
  timezone: "Asia/Riyadh",
  status_now: "live",
  focus_quest_id: null,
  goal_reward_id: null,
  rehearsal: false,
  location_prompt: false,
  now: NOW,
  ...fields,
});

/** A row of member_event_quests: a plain quest in a category with no rules, changed by `fields`. */
const questRow = (fields: Record<string, unknown> = {}) => ({
  category_id: "c1",
  category_name_ar: null,
  category_name_en: "General",
  quest_id: "q1",
  title_ar: null,
  title_en: "Quest",
  description_ar: null,
  description_en: null,
  type: "enter_code",
  points: 10,
  repeat_cap: 1,
  opens_at: null,
  closes_at: null,
  done: 0,
  earned: "0",
  verification: [],
  order_mode: "any",
  category_opens_at: null,
  unlock_after: null,
  unlock_after_name_ar: null,
  unlock_after_name_en: null,
  completion_bonus: 0,
  bonus_earned: "0",
  bonus_settled: false,
  lock: null,
  steps_done: null,
  steps_needed: null,
  refresh: "none",
  resets_at: null,
  item_ar: null,
  item_en: null,
  bonus_item_ar: null,
  bonus_item_en: null,
  place_lat: null,
  place_lng: null,
  place_radius_m: null,
  daily_cap: null,
  met_today: null,
  game_left: null,
  game_passed: null,
  flash_closes_at: null,
  boost: null,
  first_bonus_points: null,
  first_bonus_slots: null,
  first_bonus_place: null,
  ...fields,
});

type Rows = Readonly<{
  standing?: Record<string, unknown>;
  quests?: readonly Record<string, unknown>[];
  results?: readonly Record<string, unknown>[];
  activity?: readonly Record<string, unknown>[];
  unread?: number;
  bonuses?: readonly Record<string, unknown>[];
  streak?: readonly Record<string, unknown>[];
}>;

/** The home's dependencies over a database that answers each read with these rows. */
function homeDeps(rows: Rows) {
  const { pool } = fakePool((sql) => {
    if (sql.includes("FROM enrollment n JOIN event e")) {
      return { rows: [standing(rows.standing)] };
    }
    if (sql.includes("member_event_quests")) {
      return { rows: rows.quests ?? [] };
    }
    if (sql.includes("first_bonus_left")) {
      return { rows: rows.bonuses ?? [] };
    }
    if (sql.includes("own_pending_points")) {
      return { rows: [{ points: "0" }] };
    }
    if (sql.includes("own_unread_tickets")) {
      return { rows: [{ unread: rows.unread ?? 0 }] };
    }
    if (sql.includes("event_results")) {
      return { rows: rows.results ?? [] };
    }
    if (sql.includes("member_activity")) {
      return { rows: rows.activity ?? [] };
    }
    if (sql.includes("shop_rewards")) {
      return { rows: [] };
    }
    if (sql.includes("own_event_streak")) {
      return { rows: rows.streak ?? [] };
    }
    throw new Error(`unexpected query: ${sql}`);
  });
  return { pool, settings, firstBonus: createFirstBonusCache() };
}

const questsOf = async (
  rows: readonly Record<string, unknown>[],
  bonuses: readonly Record<string, unknown>[] = [],
) => {
  const view = await memberQuests(homeDeps({ quests: rows, bonuses }), PLAYER, EVENT);
  if (view.kind !== "quests") {
    throw new Error(`not quests: ${view.kind}`);
  }
  return view.categories;
};

describe("the status a player's play is judged by (ADR-159)", () => {
  it("plays a draft or scheduled event as live for a rehearsal account only", () => {
    expect(playStatus("draft", true)).toBe("live");
    expect(playStatus("scheduled", true)).toBe("live");
    expect(playStatus("draft", false)).toBe("draft");
    expect(playStatus("scheduled", false)).toBe("scheduled");
    expect(playStatus("ended", true)).toBe("ended");
    expect(playStatus("archived", true)).toBe("archived");
  });
});

describe("a member's quests as the database lists them", () => {
  it("gives each type its own extra: a passport's steps, a spot, a meet's caps, a game's attempts", async () => {
    const [category] = await questsOf([
      questRow({ quest_id: "passport", type: "passport", steps_done: 1, steps_needed: 3 }),
      questRow({
        quest_id: "spot",
        type: "location",
        place_lat: "24.713600",
        place_lng: "46.675300",
        place_radius_m: 50,
      }),
      questRow({ quest_id: "meet", type: "meet", daily_cap: 5, met_today: 2 }),
      questRow({ quest_id: "game", type: "game", game_left: 2, game_passed: false }),
      questRow({ quest_id: "plain" }),
    ]);
    const extras = category?.quests.map(({ id, steps, place, meet, game }) => ({
      id,
      steps,
      place,
      meet,
      game,
    }));
    const none = { steps: null, place: null, meet: null, game: null };
    expect(extras).toEqual([
      { ...none, id: "passport", steps: { done: 1, needed: 3 } },
      { ...none, id: "spot", place: { lat: 24.7136, lng: 46.6753, radiusM: 50 } },
      { ...none, id: "meet", meet: { dailyCap: 5, today: 2 } },
      { ...none, id: "game", game: { attemptsLeft: 2, passed: false } },
      { ...none, id: "plain" },
    ]);
  });

  it("gives a quest's first-N bonus with the cached left and the player's own place; none without one (T-313)", async () => {
    const [category] = await questsOf(
      [
        questRow({
          quest_id: "mine",
          first_bonus_points: 7,
          first_bonus_slots: 5,
          first_bonus_place: 2,
        }),
        questRow({ quest_id: "open", first_bonus_points: 9, first_bonus_slots: 3 }),
        questRow({ quest_id: "unseen", first_bonus_points: 4, first_bonus_slots: 8 }),
        questRow({ quest_id: "plain" }),
      ],
      [
        { quest_id: "mine", points: 7, slots: 5, free: 1, given: 4, real_given: 4 },
        { quest_id: "open", points: 9, slots: 3, free: 0, given: 3, real_given: 3 },
      ],
    );
    expect(category?.quests.map((quest) => [quest.id, quest.firstBonus])).toEqual([
      ["mine", { points: 7, slots: 5, left: 1, mine: { place: 2 } }],
      ["open", { points: 9, slots: 3, left: 0, mine: null }],
      ["unseen", { points: 4, slots: 8, left: 8, mine: null }],
      ["plain", null],
    ]);
  });

  it("names an item in the languages written, and none when neither is", async () => {
    const [category] = await questsOf([
      questRow({ quest_id: "en", item_en: "Badge", bonus_item_ar: "وسام" }),
      questRow({ quest_id: "ar", item_ar: "وسام" }),
      questRow({ quest_id: "none" }),
    ]);
    expect(category?.quests.map((quest) => quest.item)).toEqual([
      { ar: null, en: "Badge" },
      { ar: "وسام", en: null },
      null,
    ]);
    expect(category?.bonus.item).toEqual({ ar: "وسام", en: null });
  });

  it("names the category that unlocks another, and none for a category open to all", async () => {
    const categories = await questsOf([
      questRow({
        category_id: "second",
        unlock_after: "first",
        unlock_after_name_ar: "الأولى",
        unlock_after_name_en: "First",
      }),
      questRow({ category_id: "first", quest_id: "q2" }),
    ]);
    expect(categories.map((category) => [category.id, category.unlockAfter])).toEqual([
      ["second", { id: "first", name: { ar: "الأولى", en: "First" } }],
      ["first", null],
    ]);
  });
});

/** The caller's own first place in event_results, with its prize's redemption in this status. */
const result = (status: string) => ({
  rank: 1,
  username: "sara_k",
  avatar: "falcon",
  score: 90,
  prize_kind: "item",
  prize_name_ar: null,
  prize_name_en: "Hoodie",
  mine: true,
  redemption_id: "7",
  redemption_status: status,
  claim_until: null,
});

describe("the event home's switches and prize", () => {
  it("counts a switch the configuration does not name as on", async () => {
    expect(await readHome(homeDeps({}), PLAYER, EVENT)).toMatchObject({
      rankingOn: true,
      goal: null,
    });
  });

  it("shows the revealed rank prize while it waits at the desk, and not once handed over", async () => {
    const ended = { status_now: "ended" };
    const waiting = await readHome(
      homeDeps({ standing: ended, results: [result("reserved")] }),
      PLAYER,
      EVENT,
    );
    expect(waiting?.win).toMatchObject({ rank: 1, redemptionId: "7", status: "reserved" });
    const collected = await readHome(
      homeDeps({ standing: ended, results: [result("handed_over")] }),
      PLAYER,
      EVENT,
    );
    expect(collected?.win).toBeNull();
  });

  it("carries the count of unseen help-desk answers for every standing (T-310)", async () => {
    expect((await readHome(homeDeps({ unread: 2 }), PLAYER, EVENT))?.help).toEqual({ unread: 2 });
    const pending = await readHome(
      homeDeps({ standing: { status: "pending" }, unread: 1 }),
      PLAYER,
      EVENT,
    );
    expect(pending).toMatchObject({ standing: { status: "pending" }, help: { unread: 1 } });
  });

  it("carries the event streak while it is on, and none while off or for a pending member (T-405)", async () => {
    const streak = {
      is_on: true,
      days: 3,
      played_today: false,
      closed_today: true,
      bonus_points: 5,
    };
    expect((await readHome(homeDeps({ streak: [streak] }), PLAYER, EVENT))?.streak).toEqual({
      days: 3,
      playedToday: false,
      closedToday: true,
      bonusPoints: 5,
    });
    const off = homeDeps({ streak: [{ ...streak, is_on: false }] });
    expect((await readHome(off, PLAYER, EVENT))?.streak).toBeNull();
    const pending = homeDeps({ standing: { status: "pending" }, streak: [streak] });
    expect((await readHome(pending, PLAYER, EVENT))?.streak).toBeNull();
  });
});

describe("a member's points record", () => {
  it("names the quest of a quest's line, and only the kind of any other line", async () => {
    const line = {
      at: NOW,
      score_delta: "5",
      balance_delta: "5",
      title_ar: null,
      title_en: null,
      multiplier: null,
    };
    const view = await memberActivity(
      homeDeps({
        activity: [
          { ...line, id: "2", kind: "award", quest_id: null },
          { ...line, id: "1", kind: "quest", quest_id: "q1", title_en: "Quest", multiplier: 2 },
        ],
      }),
      PLAYER,
      { eventId: EVENT, beforeId: null, limit: 25 },
    );
    expect(view).toMatchObject({
      kind: "entries",
      entries: [
        { id: "2", reason: { type: "award" }, multiplier: null },
        {
          id: "1",
          reason: { type: "quest", questId: "q1", title: { ar: null, en: "Quest" } },
          multiplier: 2,
        },
      ],
    });
  });
});
