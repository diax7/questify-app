import type { EventStreak, ShopWindow } from "@questify/shared";
import type { Pool, PoolClient } from "pg";
import { lockNoteOf, type CommunityLock } from "#src/community/lock-note";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import { pickGoal, type Goal, type GoalReward } from "#src/home/goal";
import {
  readFirstBonuses,
  type FirstBonusCache,
  type FirstBonusCount,
} from "#src/quests/first-bonus";
import {
  categoriesWithoutSwitchedOff,
  switchedOffTypes,
  withoutSwitchedOff,
} from "#src/quests/switched-off";
import { resultsFor, type MyPrize } from "#src/results/results";
import type { SettingsService } from "#src/settings/service";
import { homeWindowOf, type EventShopRow } from "#src/rewards/shop-window";
import { readOwnEventStreak } from "#src/streaks/streaks";
import { readPendingPoints } from "#src/submissions/submissions";
import { readUnreadTickets } from "#src/tickets/tickets";

export type HomeDeps = Readonly<{
  pool: Pool;
  settings: SettingsService;
  /** The per-event 2-second cache of the first-N bonus counts (T-313, ADR-263), shared with the live read. */
  firstBonus: FirstBonusCache;
}>;

type Text = Readonly<{ ar: string | null; en: string | null }>;

/** A quest as the event's members see it (`member_event_quests`, migration 0021). */
export type MemberQuest = Readonly<{
  id: string;
  title: Text;
  description: Text;
  type: string;
  points: number;
  repeatCap: number;
  opensAt: Date | null;
  closesAt: Date | null;
  /** How many times the calling player completed it, in its category's current period (T-304c). */
  done: number;
  /** The points the calling player earned from it, from the ledger (migration 0022). */
  earned: number;
  /** How it is verified (FR-301): `my_qr` alone means the player shows their My QR to staff (migration 0026). */
  verification: readonly string[];
  /** Why its category keeps it shut for this player now, or null (T-304, migration 0044). */
  lock: QuestLock | null;
  /** A passport's progress (T-304b): the steps this player stamped of those it needs; null for other types. */
  steps: Readonly<{ done: number; needed: number }> | null;
  /** The quest item its first completion still gives this player while stock is left (T-304d), or null. */
  item: Text | null;
  /** A location quest's spot (T-303b), so the app can say how far it is; null for every other type. */
  place: Readonly<{ lat: number; lng: number; radiusM: number }> | null;
  /** A meet quest's daily cap and this player's meetings today, either side (T-303c); null for every other type. */
  meet: Readonly<{ dailyCap: number; today: number }> | null;
  /** A game quest's attempts left (null when unlimited) and whether a round passed (T-305); null for other types. */
  game: Readonly<{ attemptsLeft: number | null; passed: boolean }> | null;
  /** The community goal holding it shut, its category's included (T-306c, ADR-228); null when free. */
  communityLock: CommunityLock | null;
  /** A flash quest's end (T-307, FR-251): listed only inside its window; null for every other quest. */
  flash: Readonly<{ closesAt: Date }> | null;
  /** The boost doubling its category for this player now (T-307, FR-252), or null. */
  boost: RunningBoost | null;
  /** Its first-N bonus (T-313, FR-1840), or null: `left` from the 2-second cache, `mine` this player's own place. */
  firstBonus: QuestFirstBonus | null;
  /** Paused by the organizer (T-603b): it accepts no new start until resumed. */
  paused: boolean;
}>;

/** A quest's first-N bonus as a player sees it: `mine` once they got it, else null. */
export type QuestFirstBonus = Readonly<{
  points: number;
  slots: number;
  left: number;
  mine: Readonly<{ place: number }> | null;
}>;

/** A boost in force for this player (T-307): what the quest pays is its points times `multiplier` until `endsAt`. */
export type RunningBoost = Readonly<{ multiplier: number; endsAt: Date }>;

/**
 * Why a quest is shut (ADR-201): a community goal not yet reached (T-306c, checked first), or its category's gates:
 * not opened yet, waiting on another category, or an earlier quest in order.
 */
export type QuestLock =
  | "community_locked"
  | "category_not_started"
  | "category_locked"
  | "order_locked";

/** A category's rules as the player sees them (FR-230 to FR-235). */
export type CategoryRules = Readonly<{
  orderMode: "any" | "in_order";
  opensAt: Date | null;
  /** The category that unlocks this one, or null. */
  unlockAfter: Readonly<{ id: string; name: Text }> | null;
  /**
   * The completion bonus, what this player earned from it (0 before, the bonus after, less a removal), and whether it
   * is settled: paid, or since removed or withheld, so it is never paid again.
   */
  bonus: Readonly<{ points: number; earned: number; settled: boolean; item: Text | null }>;
  /**
   * How often its quests start again (T-304c, FR-236): `done`, the gates and `bonus.settled` count this period only;
   * `earned` stays lifetime. `resetsAt` is the next period's start, null for none.
   */
  refresh: "none" | "daily" | "weekly";
  resetsAt: Date | null;
  /** The community goal locking the category as a whole (T-306c), shown once as a category note; null when free. */
  communityLock: CommunityLock | null;
  /** The boost doubling the category for this player now (T-307), or null. */
  boost: RunningBoost | null;
}>;

export type MemberCategory = Readonly<{ id: string; name: Text; quests: MemberQuest[] }> &
  CategoryRules;

export type UpNext = Readonly<{ questId: string; title: Text; points: number; type: string }>;

export type EventStatusNow = "draft" | "scheduled" | "live" | "ended" | "archived";

export type Home = Readonly<{
  event: Readonly<{
    id: string;
    name: Text;
    venue: Text;
    startsAt: Date | null;
    endsAt: Date | null;
    timezone: string;
    statusNow: EventStatusNow;
    /** The caller is a rehearsal account (T-211): everything they do is erased at go-live. */
    rehearsal: boolean;
    /**
     * An in-person event with a venue pin (T-303b, ADR-208): the app may explain location once after joining, while
     * the platform's location switch is on. Never the pin itself.
     */
    locationPrompt: boolean;
  }>;
  standing:
    | Readonly<{
        status: "active";
        score: number;
        balance: number;
        /** Points waiting on the team's review, shown apart from the balance (FR-409, T-301). */
        pendingPoints: number;
        questsDone: number;
        questsTotal: number;
      }>
    /** Waiting for the team's decision (FR-1819), or on a full event's waiting list (FR-1821). */
    | Readonly<{ status: "pending"; waitlisted: boolean }>
    /** The team declined the request (ADR-167): Home says so, nothing else. */
    | Readonly<{ status: "declined" }>;
  upNext: UpNext | null;
  /**
   * The pinned reward or the next reachable one (FR-803, T-213); null with no shop, once it has closed (T-410), or with
   * nothing to reach.
   */
  goal: Goal | null;
  /**
   * The shop's window as the shop shows it to this player (T-410, ADR-338): its state, when it closes and when the
   * desk's hours end before that; null while the shop switch is off and for a member who is not active.
   */
  shopWindow: ShopWindow | null;
  /** The caller's rank prize while it waits at the desk, once the winners are revealed (FR-1718, T-214). */
  win: MyPrize | null;
  /**
   * Set once the owner revealed the winners (T-307b, FR-407): the app plays the full-screen finale celebration once. `place`
   * is the caller's own place when it is among the frozen ones, else null; nobody else's place or score is carried.
   */
  finale: Readonly<{ place: number | null }> | null;
  rankingOn: boolean;
  /** The team answered the player's requests (T-310): Home's strip while any answer is unseen, whatever the switch. */
  help: Readonly<{ unread: number }>;
  /** The player's own event day streak (T-405, FR-417); null while it is off or for a member who is not active. */
  streak: EventStreak | null;
}>;

/**
 * The status a player's play is judged by: a rehearsal account plays a Draft or Scheduled event as if it were live
 * (ADR-159); everyone else by the event's own status.
 */
export function playStatus(statusNow: EventStatusNow, rehearsal: boolean): EventStatusNow {
  return rehearsal && (statusNow === "draft" || statusNow === "scheduled") ? "live" : statusNow;
}

/** Finished means done to its repeat cap: the same rule for progress and for Up next, so they never disagree. */
export const finished = (quest: MemberQuest): boolean => quest.done >= quest.repeatCap;

export type QuestState = "done" | "not_live" | "paused" | "locked" | "not_yet" | "closed" | "open";

/**
 * Where a quest stands for this player now, the one rule for Home's Up next and the Quests tab: finished first, then
 * the event not live, then a pause by the organizer (T-603b), then its category's lock (T-304), then the quest's
 * window (open from `opensAt`, closed at
 * `closesAt`). `now` is the database's.
 */
export function questState(quest: MemberQuest, statusNow: EventStatusNow, now: Date): QuestState {
  if (finished(quest)) {
    return "done";
  }
  if (statusNow !== "live") {
    return "not_live";
  }
  if (quest.paused) {
    return "paused";
  }
  if (quest.lock !== null) {
    return "locked";
  }
  if (quest.opensAt !== null && quest.opensAt > now) {
    return "not_yet";
  }
  return quest.closesAt !== null && quest.closesAt <= now ? "closed" : "open";
}

/** Open for this player now: the event is live, the quest's window holds `now`, and they have not finished it. */
export const isOpen = (quest: MemberQuest, statusNow: EventStatusNow, now: Date): boolean =>
  questState(quest, statusNow, now) === "open";

/**
 * Up next (FR-804, FR-1748): the pinned quest while it is open for this player; else the open quest with the most
 * points, the first in the event's order on a tie (Q-101: points per estimated minute once quests have a time).
 */
export function pickUpNext(
  quests: readonly MemberQuest[],
  focusQuestId: string | null,
  statusNow: EventStatusNow,
  now: Date,
): UpNext | null {
  const open = quests.filter((quest) => isOpen(quest, statusNow, now));
  const pinned = open.find((quest) => quest.id === focusQuestId);
  const chosen =
    pinned ??
    open.reduce<MemberQuest | undefined>(
      (best, quest) => (best === undefined || quest.points > best.points ? quest : best),
      undefined,
    );
  return chosen === undefined
    ? null
    : { questId: chosen.id, title: chosen.title, points: chosen.points, type: chosen.type };
}

type QuestRow = Readonly<{
  category_id: string;
  category_name_ar: string | null;
  category_name_en: string | null;
  quest_id: string;
  title_ar: string | null;
  title_en: string | null;
  description_ar: string | null;
  description_en: string | null;
  type: string;
  points: number;
  repeat_cap: number;
  opens_at: Date | null;
  closes_at: Date | null;
  done: number;
  /** bigint: pg returns it as text. */
  earned: string;
  verification: string[];
  order_mode: "any" | "in_order";
  category_opens_at: Date | null;
  unlock_after: string | null;
  unlock_after_name_ar: string | null;
  unlock_after_name_en: string | null;
  completion_bonus: number;
  /** bigint: pg returns it as text. */
  bonus_earned: string;
  bonus_settled: boolean;
  lock: QuestLock | null;
  steps_done: number | null;
  steps_needed: number | null;
  refresh: "none" | "daily" | "weekly";
  resets_at: Date | null;
  item_ar: string | null;
  item_en: string | null;
  bonus_item_ar: string | null;
  bonus_item_en: string | null;
  /** numeric: pg returns them as text. */
  place_lat: string | null;
  place_lng: string | null;
  place_radius_m: number | null;
  daily_cap: number | null;
  met_today: number | null;
  game_left: number | null;
  game_passed: boolean | null;
  community_lock: unknown;
  category_community_lock: unknown;
  flash_closes_at: Date | null;
  /** jsonb: `{boostId, multiplier, endsAt}` or null. */
  boost: Readonly<{ multiplier: number; endsAt: string }> | null;
  first_bonus_points: number | null;
  first_bonus_slots: number | null;
  first_bonus_place: number | null;
  paused: boolean;
}>;

/** The running boost a row names, with its end as a time. */
const boostOf = (row: QuestRow): RunningBoost | null =>
  row.boost === null
    ? null
    : { multiplier: row.boost.multiplier, endsAt: new Date(row.boost.endsAt) };

/** An item's name, or null when the row names none. */
const itemName = (ar: string | null, en: string | null): Text | null =>
  ar === null && en === null ? null : { ar, en };

const rulesOf = (row: QuestRow): CategoryRules => ({
  orderMode: row.order_mode,
  opensAt: row.category_opens_at,
  unlockAfter:
    row.unlock_after === null
      ? null
      : {
          id: row.unlock_after,
          name: { ar: row.unlock_after_name_ar, en: row.unlock_after_name_en },
        },
  bonus: {
    points: row.completion_bonus,
    earned: Number(row.bonus_earned),
    settled: row.bonus_settled,
    item: itemName(row.bonus_item_ar, row.bonus_item_en),
  },
  refresh: row.refresh,
  resetsAt: row.resets_at,
  communityLock: lockNoteOf(row.category_community_lock),
  boost: boostOf(row),
});

const asPlayer = <T>(deps: HomeDeps, playerId: string, work: (client: PoolClient) => Promise<T>) =>
  withConnection(deps.pool, (client) =>
    withRequestContext(client, { playerId }, () => work(client)),
  );

/** A row's first-N bonus with the cached count of what is left (the full N when the cache has not seen it yet). */
const firstBonusOf = (
  row: QuestRow,
  counts: ReadonlyMap<string, FirstBonusCount>,
): QuestFirstBonus | null =>
  row.first_bonus_points === null || row.first_bonus_slots === null
    ? null
    : {
        points: row.first_bonus_points,
        slots: row.first_bonus_slots,
        left: counts.get(row.quest_id)?.left ?? row.first_bonus_slots,
        mine: row.first_bonus_place === null ? null : { place: row.first_bonus_place },
      };

async function questRows(
  client: PoolClient,
  eventId: string,
  counts: ReadonlyMap<string, FirstBonusCount> = new Map(),
): Promise<MemberCategory[]> {
  const { rows } = await client.query<QuestRow>("SELECT * FROM member_event_quests($1)", [eventId]);
  const categories = new Map<string, MemberCategory>();
  for (const row of rows) {
    const category = categories.get(row.category_id) ?? {
      id: row.category_id,
      name: { ar: row.category_name_ar, en: row.category_name_en },
      ...rulesOf(row),
      quests: [],
    };
    category.quests.push({
      id: row.quest_id,
      title: { ar: row.title_ar, en: row.title_en },
      description: { ar: row.description_ar, en: row.description_en },
      type: row.type,
      points: row.points,
      repeatCap: row.repeat_cap,
      opensAt: row.opens_at,
      closesAt: row.closes_at,
      done: row.done,
      earned: Number(row.earned),
      verification: row.verification,
      lock: row.lock,
      steps:
        row.steps_done === null || row.steps_needed === null
          ? null
          : { done: row.steps_done, needed: row.steps_needed },
      item: itemName(row.item_ar, row.item_en),
      place:
        row.place_lat === null || row.place_lng === null || row.place_radius_m === null
          ? null
          : { lat: Number(row.place_lat), lng: Number(row.place_lng), radiusM: row.place_radius_m },
      meet:
        row.daily_cap === null || row.met_today === null
          ? null
          : { dailyCap: row.daily_cap, today: row.met_today },
      game:
        row.game_passed === null ? null : { attemptsLeft: row.game_left, passed: row.game_passed },
      communityLock: lockNoteOf(row.community_lock),
      flash: row.flash_closes_at === null ? null : { closesAt: row.flash_closes_at },
      boost: boostOf(row),
      firstBonus: firstBonusOf(row, counts),
      paused: row.paused,
    });
    categories.set(row.category_id, category);
  }
  return [...categories.values()];
}

export type QuestsView =
  | Readonly<{
      kind: "quests";
      event: Readonly<{ statusNow: EventStatusNow; timezone: string; rehearsal: boolean }>;
      categories: readonly (CategoryRules &
        Readonly<{
          id: string;
          name: Text;
          quests: readonly (MemberQuest & Readonly<{ state: QuestState }>)[];
        }>)[];
    }>
  /** An enrollment waiting for the owner's approval (FR-1819): told so, and shown nothing else. */
  | Readonly<{ kind: "pending" }>
  /** A stranger, or a left, removed or banned member: the same whether or not the event exists. */
  | Readonly<{ kind: "not_member" }>;

/** The event's quests for an active member (T-114's tab), each with its state on the database's clock. */
export async function memberQuests(
  deps: HomeDeps,
  playerId: string,
  eventId: string,
): Promise<QuestsView> {
  const off = await switchedOffTypes(deps.settings, eventId, playerId);
  return asPlayer(deps, playerId, async (client) => {
    const row = await standingOf(client, playerId, eventId);
    if (row?.status === "pending") {
      return { kind: "pending" } as const;
    }
    if (row?.status !== "active") {
      return { kind: "not_member" } as const;
    }
    // Read only after the membership gate above: the cache is per event, whoever filled it.
    const counts = await deps.firstBonus.get(eventId, () => readFirstBonuses(client, eventId));
    const shown = categoriesWithoutSwitchedOff(
      await questRows(client, eventId, new Map(counts.map((count) => [count.questId, count]))),
      off,
    );
    const categories = shown.map((category) => ({
      ...category,
      quests: category.quests.map((quest) => ({
        ...quest,
        state: questState(quest, playStatus(row.status_now, row.rehearsal), row.now),
      })),
    }));
    return {
      kind: "quests",
      event: { statusNow: row.status_now, timezone: row.timezone, rehearsal: row.rehearsal },
      categories,
    } as const;
  });
}

type StandingRow = Readonly<{
  status: string;
  waitlisted: boolean;
  score: string;
  balance: string;
  name_ar: string | null;
  name_en: string | null;
  venue_ar: string | null;
  venue_en: string | null;
  starts_at: Date | null;
  ends_at: Date | null;
  timezone: string;
  status_now: EventStatusNow;
  focus_quest_id: string | null;
  goal_reward_id: string | null;
  rehearsal: boolean;
  location_prompt: boolean;
  /** The database's clock: the same one that decided `status_now`, so "open" has one source. */
  now: Date;
}>;

/** The player's own enrollment and its event, read under their own rules (a player reads only their events). */
async function standingOf(
  client: PoolClient,
  playerId: string,
  eventId: string,
): Promise<StandingRow | undefined> {
  const { rows } = await client.query<StandingRow>(
    `SELECT n.status, n.waitlisted, n.score, n.balance, e.name_ar, e.name_en, e.venue_ar, e.venue_en, e.starts_at, e.ends_at,
            e.timezone, event_status_now(e.status, e.starts_at, e.ends_at) AS status_now, e.focus_quest_id,
            n.goal_reward_id,
            n.joined_via IS NOT DISTINCT FROM 'rehearsal' AS rehearsal,
            e.kind <> 'virtual' AND e.venue_lat IS NOT NULL AS location_prompt, now() AS now
     FROM enrollment n JOIN event e ON e.id = n.event_id JOIN player p ON p.id = n.player_id
     WHERE n.event_id = $1 AND n.player_id = $2 AND p.status = 'active'`,
    [eventId, playerId],
  );
  return rows[0];
}

type ShopRewardRow = Readonly<{
  id: string;
  name_ar: string | null;
  name_en: string | null;
  price: number;
  stock_left: number;
  per_player_limit: number | null;
  held_by_me: number;
  closes_at: Date | null;
  community_lock: unknown;
}>;

/** The shop's rewards for the goal, in shop order (`shop_rewards`: the caller's own view, empty for a non-member). */
async function goalRewards(client: PoolClient, eventId: string): Promise<GoalReward[]> {
  const { rows } = await client.query<ShopRewardRow>("SELECT * FROM shop_rewards($1)", [eventId]);
  return rows.map((row) => ({
    id: row.id,
    name: { ar: row.name_ar, en: row.name_en },
    price: row.price,
    stockLeft: row.stock_left,
    perPlayerLimit: row.per_player_limit,
    heldByMe: row.held_by_me,
    closesAt: row.closes_at,
    communityLock: lockNoteOf(row.community_lock),
  }));
}

/** Home with the shop switch off, or with no shop row for the caller: no window and no goal. */
const NO_SHOP = { shopWindow: null, goal: null } as const;

/**
 * The event Home (FR-801, FR-804): the event, the player's standing and progress, Up next, the goal (FR-803), and
 * whether the ranking is on. A pending member gets the event and "pending" only; anyone not active or pending gets null (403).
 */
export async function readHome(
  deps: HomeDeps,
  playerId: string,
  eventId: string,
): Promise<Home | null> {
  // Read first, so an event whose shop is off skips the shop's read. Safe before the membership check: it answers only
  // what the caller may see (as GET /config does), and nothing from it is returned to a non-member.
  const config = await deps.settings.forEvent(eventId, playerId);
  const rankingOn = config.kind === "ok" && config.config.features["ranking"]?.enabled !== false;
  const shopOn = config.kind === "ok" && config.config.features["shop"]?.enabled !== false;
  const off = await switchedOffTypes(deps.settings, eventId, playerId);
  const home = await asPlayer(deps, playerId, async (client) => {
    const row = await standingOf(client, playerId, eventId);
    if (row === undefined || !["active", "pending", "declined"].includes(row.status)) {
      return null;
    }
    const event = {
      id: eventId,
      name: { ar: row.name_ar, en: row.name_en },
      venue: { ar: row.venue_ar, en: row.venue_en },
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      timezone: row.timezone,
      statusNow: row.status_now,
      rehearsal: row.rehearsal,
      locationPrompt: row.location_prompt,
    };
    const help = { unread: await readUnreadTickets(client, eventId) };
    if (row.status === "pending" || row.status === "declined") {
      return {
        help,
        event,
        standing:
          row.status === "pending"
            ? { status: "pending" as const, waitlisted: row.waitlisted }
            : { status: "declined" as const },
        upNext: null,
        goal: null,
        shopWindow: null,
        win: null,
        finale: null,
        streak: null,
      };
    }
    const quests = withoutSwitchedOff(
      (await questRows(client, eventId)).flatMap((category) => category.quests),
      off,
    );
    const balance = Number(row.balance);
    return {
      help,
      event,
      standing: {
        status: "active" as const,
        score: Number(row.score),
        balance,
        pendingPoints: await readPendingPoints(client, eventId),
        questsDone: quests.filter(finished).length,
        questsTotal: quests.length,
      },
      upNext: pickUpNext(
        quests,
        row.focus_quest_id,
        playStatus(row.status_now, row.rehearsal),
        row.now,
      ),
      ...(shopOn ? await shopAndGoal(client, eventId, row) : NO_SHOP),
      ...(row.status_now === "ended" ? await afterReveal(client, eventId) : NOT_REVEALED),
      streak: await readOwnEventStreak(client, eventId),
    };
  });
  return home === null ? null : { ...home, rankingOn };
}

/**
 * The shop's window as `event_shop` shows it to the caller and the goal it allows (none once the shop has closed);
 * neither without a shop row.
 */
async function shopAndGoal(
  client: PoolClient,
  eventId: string,
  row: StandingRow,
): Promise<Readonly<{ shopWindow: ShopWindow | null; goal: Goal | null }>> {
  const shopWindow = await readShopWindow(client, eventId);
  if (shopWindow === null) {
    return NO_SHOP;
  }
  const rewards = await goalRewards(client, eventId);
  const goal = pickGoal(
    rewards,
    row.goal_reward_id,
    Number(row.balance),
    row.now,
    shopWindow.state,
  );
  return { shopWindow, goal };
}

/** The shop's window as `event_shop` shows it to the caller (open to a rehearsal account); null without a row. */
async function readShopWindow(client: PoolClient, eventId: string): Promise<ShopWindow | null> {
  const { rows } = await client.query<EventShopRow>(
    "SELECT state, closes_at, desk_closes FROM event_shop($1)",
    [eventId],
  );
  return rows[0] === undefined ? null : homeWindowOf(rows[0]);
}

const NOT_REVEALED = { win: null, finale: null } as const;

/** The caller's revealed rank prize while it is still to collect, and the finale's mark once the winners are revealed. */
async function afterReveal(
  client: PoolClient,
  eventId: string,
): Promise<Pick<Home, "win" | "finale">> {
  const results = await resultsFor(client, eventId);
  return {
    win: results.me?.status === "reserved" ? results.me : null,
    finale: results.revealed
      ? { place: results.places.find((place) => place.mine)?.rank ?? null }
      : null,
  };
}

/** One line of a player's points record (FR-410), as `member_activity` gives it (migration 0023). */
export type ActivityEntry = Readonly<{
  id: string;
  at: Date;
  kind: string;
  scoreDelta: number;
  balanceDelta: number;
  reason: Readonly<{ type: "quest"; questId: string; title: Text }> | Readonly<{ type: string }>;
  /** The boost that doubled this entry or its removal (T-307), shown as "×2"; null when none. */
  multiplier: number | null;
  /** A first-N bonus line's N (T-313), "First-{slots} bonus"; null for every other line. */
  bonusSlots: number | null;
  /** A streak bonus line's streak day (T-405), "Streak bonus, day {days}"; null for every other line. */
  streakDays: number | null;
}>;

type ActivityRow = Readonly<{
  id: string;
  at: Date;
  kind: string;
  score_delta: string;
  balance_delta: string;
  quest_id: string | null;
  title_ar: string | null;
  title_en: string | null;
  multiplier: number | null;
  bonus_slots: number | null;
  streak_days: number | null;
}>;

export type ActivityView =
  | Readonly<{ kind: "entries"; entries: readonly ActivityEntry[] }>
  | Readonly<{ kind: "pending" }>
  | Readonly<{ kind: "not_member" }>;

/** The player's own points record in the event, newest first, a page before `beforeId` (a ledger id), or the first. */
export async function memberActivity(
  deps: HomeDeps,
  playerId: string,
  page: Readonly<{ eventId: string; beforeId: string | null; limit: number }>,
): Promise<ActivityView> {
  return asPlayer(deps, playerId, async (client) => {
    const row = await standingOf(client, playerId, page.eventId);
    if (row?.status === "pending") {
      return { kind: "pending" } as const;
    }
    if (row?.status !== "active") {
      return { kind: "not_member" } as const;
    }
    const { rows } = await client.query<ActivityRow>("SELECT * FROM member_activity($1, $2, $3)", [
      page.eventId,
      page.beforeId,
      page.limit,
    ]);
    const entries = rows.map((entry) => ({
      id: entry.id,
      at: entry.at,
      kind: entry.kind,
      scoreDelta: Number(entry.score_delta),
      balanceDelta: Number(entry.balance_delta),
      reason:
        entry.quest_id === null
          ? { type: entry.kind }
          : {
              type: "quest" as const,
              questId: entry.quest_id,
              title: { ar: entry.title_ar, en: entry.title_en },
            },
      multiplier: entry.multiplier,
      bonusSlots: entry.bonus_slots,
      streakDays: entry.streak_days,
    }));
    return { kind: "entries", entries } as const;
  });
}
