import type { Pool } from "pg";

/** How long one read of the suspended events serves: the API walls follow a suspension within this (ADR-406). */
export const SUSPENDED_REFRESH_MS = 10_000;

export type SuspendedSet = Readonly<{
  /** Whether the event (or its organizer) is suspended, as of the last read at most 10 s ago. */
  has: (eventId: string) => Promise<boolean>;
  /** Whether any event is suspended, from the same read: while none is, a wall need not look an event up. */
  any: () => Promise<boolean>;
  /** Forgets the last read, so the next question reads again: called on this instance after a change. */
  invalidate: () => void;
}>;

/**
 * The ids of the suspended events, read with `suspended_ids()` (ids only) at most every 10 s and shared by every
 * request on this instance; one read at a time. The database walls (join, ledger, public reads) are immediate; this set
 * serves the API walls (the player routes, the dashboard's writes). A failed read is not cached: the request fails
 * and the next one reads again.
 */
export function createSuspendedSet(
  pool: Pool,
  options: Readonly<{ refreshMs?: number; now?: () => number }> = {},
): SuspendedSet {
  const refreshMs = options.refreshMs ?? SUSPENDED_REFRESH_MS;
  const now = options.now ?? Date.now;
  let ids: ReadonlySet<string> = new Set();
  let readAt = Number.NEGATIVE_INFINITY;
  let reading: Promise<ReadonlySet<string>> | undefined;
  let generation = 0;

  const read = async (): Promise<ReadonlySet<string>> => {
    const started = generation;
    const { rows } = await pool.query<{ ids: string[] }>("SELECT suspended_ids() AS ids");
    const fresh = new Set(rows[0]?.ids ?? []);
    if (started === generation) {
      ids = fresh;
      readAt = now();
    }
    return fresh;
  };

  const current = async (): Promise<ReadonlySet<string>> => {
    if (now() - readAt < refreshMs) {
      return ids;
    }
    reading ??= read().finally(() => {
      reading = undefined;
    });
    return reading;
  };

  return {
    has: async (eventId) => (await current()).has(eventId),
    any: async () => (await current()).size > 0,
    invalidate: () => {
      generation += 1;
      readAt = Number.NEGATIVE_INFINITY;
      reading = undefined;
    },
  };
}
