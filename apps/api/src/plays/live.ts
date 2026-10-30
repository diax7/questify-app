import type { Pool } from "pg";
import { communityPlatformOn } from "#src/community/goals";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import { etagOf } from "#src/etag";
import { readFirstBonuses, type FirstBonusCache } from "#src/quests/first-bonus";
import type { SettingsService } from "#src/settings/service";

/** A step of the community goal as the player sees it, with their own payout (`mine`) when the step pays them. */
export type LiveStep = Readonly<{
  threshold: number;
  isGoal: boolean;
  reward: Readonly<{
    kind: "points" | "moment" | "nothing" | "unlock";
    points?: number;
    moment?: Readonly<{ ar?: string; en?: string }>;
    /** What an unlock opens, only when the player sees it; absent means "a surprise" (T-306c, ADR-228). */
    target?: Readonly<{
      kind: "quest" | "category" | "reward";
      id: string;
      name: Readonly<{ ar?: string; en?: string }>;
    }>;
  }>;
  reachedAt: string | null;
  mine: "due" | "paid" | "skipped" | null;
}>;

/** The community goal running now, or finished in the last 30 minutes (T-306b, FR-250). */
export type LiveCommunity = Readonly<{
  goalId: string;
  title: Readonly<{ ar: string | null; en: string | null }>;
  measure: "points" | "completions" | "players";
  target: number;
  progress: number;
  status: "running" | "reached" | "missed";
  paidTo: "contributors" | "everyone";
  /** The window's end; between it and the finish the app shows "Counting the last points…". */
  endsAt: string;
  steps: readonly LiveStep[];
  contributed: boolean;
}>;

/** A boost running on a category this player sees (T-307). */
export type LiveBoost = Readonly<{
  boostId: string;
  categoryId: string;
  category: Readonly<{ ar: string | null; en: string | null }>;
  multiplier: number;
  endsAt: string;
}>;

/**
 * What is live in an event for one player now (ADR-221): the polls to show and the at_close results just in, the
 * community goal, the flash quests open now and the boosts running (T-307). The event's 3-second "anything live" check
 * stops answering a flash quest or a boost 15 minutes after it starts (CTO 8), so the app takes these as one-time
 * cards only: what runs now is read from the quests read (each quest's `flash` and `boost`).
 */
export type LiveState = Readonly<{
  polls: readonly Readonly<{ questId: string; closesAt: string }>[];
  closed: readonly Readonly<{ questId: string }>[];
  /** The community goal (T-306b); null when none is shown or the platform switch is off. */
  community: LiveCommunity | null;
  /** The flash quests open now that the player may play, with their titles. */
  flash: readonly Readonly<{
    questId: string;
    title: Readonly<{ ar: string | null; en: string | null }>;
    closesAt: string;
  }>[];
  boosts: readonly LiveBoost[];
  /**
   * The first-N bonuses of the quests this player may play now and has never completed (T-313, ADR-263), with what is
   * left from the 2-second cache, 0 included ("All taken"). The app's ribbon reads `left` from here, never by a re-read
   * of the quests (CTO MAJOR 3).
   */
  firstBonus: readonly Readonly<{ questId: string; left: number; slots: number }>[];
  /** The cheers moment live now (T-509, FR-1841): the app shows its cheer button until `endsAt`; null when none is live. */
  cheers: Readonly<{ endsAt: string }> | null;
}>;

export const EMPTY_LIVE: LiveState = {
  polls: [],
  closed: [],
  community: null,
  flash: [],
  boosts: [],
  firstBonus: [],
  cheers: null,
};

/** What live_state answers: the bonus quests' ids only, the counts come from the cache; cheers are read apart. */
type LiveRow = Omit<LiveState, "firstBonus" | "cheers"> &
  Readonly<{ firstBonus?: readonly string[] }>;

/** How long an event's "anything live" answer is kept (CTO 7), and the per-player limit on the live read. */
export const LIVE_CACHE_MS = 3000;
export const LIVE_LIMIT = { max: 30, windowMs: 60_000 } as const;
/** Past this many entries a map is emptied rather than grown (one instance's events and players in a minute). */
const MAP_CAP = 20_000;

export type LiveDeps = Readonly<{
  pool: Pool;
  settings: Pick<SettingsService, "forEvent">;
  firstBonus: FirstBonusCache;
}>;

/** The weak ETag of a live answer: over the body without `serverNow`, which changes every call (CTO 3). */
export const liveEtagOf = (state: LiveState): string => `W/${etagOf(state)}`;

export type LiveReader = Readonly<{
  /** Counts one call against the player's limit: undefined when allowed, else the seconds to wait. */
  allow: (playerId: string) => number | undefined;
  /** The player's live state for the event; the same empty state for anyone who is not an active member. */
  read: (playerId: string, eventId: string) => Promise<LiveState>;
}>;

/** An event-level yes or no from the database, kept for 3 s: it says nothing about any player. */
function eventFlag(
  deps: LiveDeps,
  now: () => number,
  sql: string,
): (eventId: string) => Promise<boolean> {
  const kept = new Map<string, Readonly<{ until: number; value: boolean }>>();
  return async (eventId) => {
    const found = kept.get(eventId);
    if (found !== undefined && found.until > now()) {
      return found.value;
    }
    const value = await withConnection(deps.pool, (client) =>
      withRequestContext(client, {}, async () => {
        const { rows } = await client.query<{ open: boolean }>(sql, [eventId]);
        return rows[0]?.open === true;
      }),
    );
    if (kept.size >= MAP_CAP) {
      kept.clear();
    }
    kept.set(eventId, { until: now() + LIVE_CACHE_MS, value });
    return value;
  };
}

/** The live cheers moment for an active member (T-509, FR-1841); null for anyone else or when none is live. */
function memberCheers(pool: Pool, playerId: string, eventId: string): Promise<LiveState["cheers"]> {
  return withConnection(pool, (client) =>
    withRequestContext(client, { playerId }, async () => {
      const { rows } = await client.query<{ answer: { endsAt: string } | null }>(
        "SELECT member_cheers($1) AS answer",
        [eventId],
      );
      const answer = rows[0]?.answer ?? null;
      return answer === null ? null : { endsAt: new Date(answer.endsAt).toISOString() };
    }),
  );
}

/**
 * The live read with this instance's memory (ADR-221): each event's "anything live" answer for 3 s, so an event with no
 * open poll is answered at once without the per-player query, and each player's calls in the current minute (a fixed
 * window per instance: polling every 10 s is 6 a minute, so 30 leaves room for returns to the app).
 */
export function createLiveReader(deps: LiveDeps, now: () => number = Date.now): LiveReader {
  const calls = new Map<string, number>();
  let minute = Math.floor(now() / LIVE_LIMIT.windowMs);

  const anythingLive = eventFlag(deps, now, "SELECT event_has_live($1) AS open");
  const anyCheers = eventFlag(deps, now, "SELECT event_has_cheers($1) AS open");

  return {
    allow: (playerId) => {
      const current = Math.floor(now() / LIVE_LIMIT.windowMs);
      if (current !== minute || calls.size >= MAP_CAP) {
        minute = current;
        calls.clear();
      }
      const count = (calls.get(playerId) ?? 0) + 1;
      calls.set(playerId, count);
      if (count <= LIVE_LIMIT.max) {
        return undefined;
      }
      return Math.max(1, Math.ceil(((current + 1) * LIVE_LIMIT.windowMs - now()) / 1000));
    },
    read: async (playerId, eventId) => {
      const cheers = (await anyCheers(eventId))
        ? await memberCheers(deps.pool, playerId, eventId)
        : null;
      if (!(await anythingLive(eventId))) {
        return cheers === null ? EMPTY_LIVE : { ...EMPTY_LIVE, cheers };
      }
      const { state, firstBonus } = await withConnection(deps.pool, (client) =>
        withRequestContext(client, { playerId }, async () => {
          const { rows } = await client.query<{ state: LiveRow }>(
            "SELECT live_state($1) AS state",
            [eventId],
          );
          const found: LiveRow = rows[0]?.state ?? { ...EMPTY_LIVE, firstBonus: [] };
          const ids = found.firstBonus ?? [];
          // The counts only for the quests live_state listed: it lists none for a stranger (CTO 6).
          const counts =
            ids.length === 0
              ? []
              : await deps.firstBonus.get(eventId, () => readFirstBonuses(client, eventId));
          const byQuest = new Map(counts.map((count) => [count.questId, count]));
          return {
            state: found,
            firstBonus: ids.flatMap((questId) => {
              const count = byQuest.get(questId);
              return count === undefined ? [] : [{ questId, left: count.left, slots: count.slots }];
            }),
          };
        }),
      );
      const community =
        state.community === null || !(await communityPlatformOn(deps.settings))
          ? null
          : communityOf(state.community);
      return {
        polls: state.polls.map((poll) => ({
          questId: poll.questId,
          closesAt: new Date(poll.closesAt).toISOString(),
        })),
        closed: state.closed,
        community,
        flash: state.flash.map((quest) => ({
          questId: quest.questId,
          title: quest.title,
          closesAt: new Date(quest.closesAt).toISOString(),
        })),
        boosts: state.boosts.map((boost) => ({
          ...boost,
          endsAt: new Date(boost.endsAt).toISOString(),
        })),
        firstBonus,
        cheers,
      };
    },
  };
}

const isoOrNull = (value: string | null): string | null =>
  value === null ? null : new Date(value).toISOString();

/** The database's card with its times as ISO strings, as the polls' are. */
const communityOf = (card: LiveCommunity): LiveCommunity => ({
  ...card,
  endsAt: new Date(card.endsAt).toISOString(),
  steps: card.steps.map((step) => ({ ...step, reachedAt: isoOrNull(step.reachedAt) })),
});
