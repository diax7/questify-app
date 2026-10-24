import type { Pool } from "pg";
import { communityPlatformOn } from "#src/community/goals";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import { etagOf } from "#src/etag";
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

/** What is live in an event for one player now (ADR-221): the polls to show and the at_close results just in. */
export type LiveState = Readonly<{
  polls: readonly Readonly<{ questId: string; closesAt: string }>[];
  closed: readonly Readonly<{ questId: string }>[];
  /** The community goal (T-306b); null when none is shown or the platform switch is off. */
  community: LiveCommunity | null;
}>;

export const EMPTY_LIVE: LiveState = { polls: [], closed: [], community: null };

/** How long an event's "anything live" answer is kept (CTO 7), and the per-player limit on the live read. */
export const LIVE_CACHE_MS = 3000;
export const LIVE_LIMIT = { max: 30, windowMs: 60_000 } as const;
/** Past this many entries a map is emptied rather than grown (one instance's events and players in a minute). */
const MAP_CAP = 20_000;

export type LiveDeps = Readonly<{ pool: Pool; settings: Pick<SettingsService, "forEvent"> }>;

/** The weak ETag of a live answer: over the body without `serverNow`, which changes every call (CTO 3). */
export const liveEtagOf = (state: LiveState): string => `W/${etagOf(state)}`;

export type LiveReader = Readonly<{
  /** Counts one call against the player's limit: undefined when allowed, else the seconds to wait. */
  allow: (playerId: string) => number | undefined;
  /** The player's live state for the event; the same empty state for anyone who is not an active member. */
  read: (playerId: string, eventId: string) => Promise<LiveState>;
}>;

/**
 * The live read with this instance's memory (ADR-221): each event's "anything live" answer for 3 s, so an event with no
 * open poll is answered at once without the per-player query, and each player's calls in the current minute (a fixed
 * window per instance: polling every 10 s is 6 a minute, so 30 leaves room for returns to the app).
 */
export function createLiveReader(deps: LiveDeps, now: () => number = Date.now): LiveReader {
  const open = new Map<string, Readonly<{ until: number; value: boolean }>>();
  const calls = new Map<string, number>();
  let minute = Math.floor(now() / LIVE_LIMIT.windowMs);

  const anythingLive = async (eventId: string): Promise<boolean> => {
    const kept = open.get(eventId);
    if (kept !== undefined && kept.until > now()) {
      return kept.value;
    }
    const value = await withConnection(deps.pool, (client) =>
      withRequestContext(client, {}, async () => {
        const { rows } = await client.query<{ open: boolean }>(
          "SELECT event_has_live($1) AS open",
          [eventId],
        );
        return rows[0]?.open === true;
      }),
    );
    if (open.size >= MAP_CAP) {
      open.clear();
    }
    open.set(eventId, { until: now() + LIVE_CACHE_MS, value });
    return value;
  };

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
      if (!(await anythingLive(eventId))) {
        return EMPTY_LIVE;
      }
      const state = await withConnection(deps.pool, (client) =>
        withRequestContext(client, { playerId }, async () => {
          const { rows } = await client.query<{ state: LiveState }>(
            "SELECT live_state($1) AS state",
            [eventId],
          );
          return rows[0]?.state ?? EMPTY_LIVE;
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
