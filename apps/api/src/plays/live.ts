import type { Pool } from "pg";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import { etagOf } from "#src/etag";

/** What is live in an event for one player now (ADR-221): the polls to show and the at_close results just in. */
export type LiveState = Readonly<{
  polls: readonly Readonly<{ questId: string; closesAt: string }>[];
  closed: readonly Readonly<{ questId: string }>[];
  /** The community goal's progress (T-306b); null until then. */
  community: null;
}>;

export const EMPTY_LIVE: LiveState = { polls: [], closed: [], community: null };

/** How long an event's "anything live" answer is kept (CTO 7), and the per-player limit on the live read. */
export const LIVE_CACHE_MS = 3000;
export const LIVE_LIMIT = { max: 30, windowMs: 60_000 } as const;
/** Past this many entries a map is emptied rather than grown (one instance's events and players in a minute). */
const MAP_CAP = 20_000;

export type LiveDeps = Readonly<{ pool: Pool }>;

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
          "SELECT event_has_open_poll($1) AS open",
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
      return withConnection(deps.pool, (client) =>
        withRequestContext(client, { playerId }, async () => {
          const { rows } = await client.query<{ state: LiveState }>(
            "SELECT live_state($1) AS state",
            [eventId],
          );
          const state = rows[0]?.state ?? EMPTY_LIVE;
          return {
            ...state,
            polls: state.polls.map((poll) => ({
              questId: poll.questId,
              closesAt: new Date(poll.closesAt).toISOString(),
            })),
          };
        }),
      );
    },
  };
}
