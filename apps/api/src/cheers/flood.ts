import { CHEERS_PER_MINUTE } from "@questify/shared";

/**
 * What one player may tap against one server in a minute before it answers without asking the database: twice the
 * database's own limit (`cheers_per_minute()`), which stays the real one and counts across servers. A refused tap here
 * takes no pool connection and no lock.
 */
export const CHEER_FLOOD = { max: CHEERS_PER_MINUTE * 2, windowMs: 60_000 } as const;
/** Past this many players a minute's counts are emptied rather than grown. */
const MAP_CAP = 20_000;

/** Counts one tap: undefined while the player is under the flood limit, else the seconds until the window ends. */
export type CheerFlood = (playerId: string) => number | undefined;

/** A fixed one-minute window per player in this server's memory (the shape of the live read's own limit). */
export function createCheerFlood(now: () => number = Date.now): CheerFlood {
  const taps = new Map<string, number>();
  let window = Math.floor(now() / CHEER_FLOOD.windowMs);
  return (playerId) => {
    const current = Math.floor(now() / CHEER_FLOOD.windowMs);
    if (current !== window || taps.size >= MAP_CAP) {
      window = current;
      taps.clear();
    }
    const count = (taps.get(playerId) ?? 0) + 1;
    taps.set(playerId, count);
    if (count <= CHEER_FLOOD.max) {
      return undefined;
    }
    return Math.max(1, Math.ceil(((current + 1) * CHEER_FLOOD.windowMs - now()) / 1000));
  };
}
