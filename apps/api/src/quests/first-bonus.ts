import type { FirstBonusInput } from "@questify/shared";
import type { PoolClient } from "pg";

/** One quest's first-N bonus as counted (first_bonus_left, migration 0062): no player in it. */
export type FirstBonusCount = Readonly<{
  questId: string;
  points: number;
  slots: number;
  /** The slots still free: "bonuses left". */
  left: number;
  /** Every claimed slot, rehearsal ones included (the lowest N may go). */
  given: number;
  /** The claims by real players: once any, the points and switching off are locked. */
  realGiven: number;
}>;

type CountRow = Readonly<{
  quest_id: string;
  points: number;
  slots: number;
  free: number;
  given: number;
  real_given: number;
}>;

/**
 * Every bonus of the event, for an active member or the event's team (the definer answers no row to anyone else,
 * CTO 6). A caller's own route gate decides first whether they may see the event at all.
 */
export async function readFirstBonuses(
  client: PoolClient,
  eventId: string,
): Promise<FirstBonusCount[]> {
  const { rows } = await client.query<CountRow>("SELECT * FROM first_bonus_left($1)", [eventId]);
  return rows.map((row) => ({
    questId: row.quest_id,
    points: row.points,
    slots: row.slots,
    left: row.free,
    given: row.given,
    realGiven: row.real_given,
  }));
}

/** How long one event's counts are kept (ADR-263): the live read polls every 10 s, so "left" lags by at most 12 s. */
export const FIRST_BONUS_CACHE_MS = 2000;
/** Past this many events an instance empties the map rather than grow it. */
const MAP_CAP = 20_000;

export type FirstBonusCache = Readonly<{
  /**
   * The event's counts, from this instance's memory while fresh, else from `load` (one load in flight per event: a
   * caller arriving meanwhile shares it). A failed load is never kept.
   */
  get: (eventId: string, load: () => Promise<FirstBonusCount[]>) => Promise<FirstBonusCount[]>;
}>;

/**
 * The per-event 2-second cache of the bonus counts (ADR-263): whatever the number of players polling, the database
 * counts each event's slots about once per instance every 2 seconds. No new dependency: a Map in the process.
 */
export function createFirstBonusCache(now: () => number = Date.now): FirstBonusCache {
  const kept = new Map<string, Readonly<{ until: number; value: Promise<FirstBonusCount[]> }>>();
  return {
    get: (eventId, load) => {
      const found = kept.get(eventId);
      if (found !== undefined && found.until > now()) {
        return found.value;
      }
      if (kept.size >= MAP_CAP) {
        kept.clear();
      }
      const value = load();
      const entry = { until: Number.POSITIVE_INFINITY, value };
      kept.set(eventId, entry);
      void value.then(
        () => {
          if (kept.get(eventId) === entry) {
            kept.set(eventId, { until: now() + FIRST_BONUS_CACHE_MS, value });
          }
        },
        () => {
          if (kept.get(eventId) === entry) {
            kept.delete(eventId);
          }
        },
      );
      return value;
    },
  };
}

/** What the builder shows of a quest's bonus (ADR-262). */
export type BuilderFirstBonus = Readonly<{
  points: number;
  slots: number;
  given: number;
  left: number;
  /** A real player got it: the points stay, it cannot be switched off, and N stays at least `given`. */
  locked: boolean;
}>;

export const builderBonusOf = (count: FirstBonusCount): BuilderFirstBonus => ({
  points: count.points,
  slots: count.slots,
  given: count.given,
  left: count.left,
  locked: count.realGiven > 0,
});

/** The setter's outcome (set_quest_first_bonus, migration 0062). */
export type FirstBonusSet = "set" | "off" | "unchanged";

/**
 * Sets, stops or switches off a quest's bonus inside the builder's transaction, after its quest write. Throws the
 * database's refusals (QB409, QB422, QE409), which the builder maps.
 */
export async function setFirstBonus(
  client: PoolClient,
  target: Readonly<{ eventId: string; questId: string }>,
  input: FirstBonusInput,
  requestId: string | undefined,
): Promise<FirstBonusSet> {
  const [points, slots] =
    input === null ? [null, null] : "stop" in input ? [null, 0] : [input.points, input.slots];
  const { rows } = await client.query<{ outcome: FirstBonusSet }>(
    "SELECT set_quest_first_bonus($1, $2, $3, $4, $5) AS outcome",
    [target.eventId, target.questId, points, slots, requestId ?? null],
  );
  return rows[0]?.outcome ?? "unchanged";
}

/**
 * The first-N bonus of the calling player's own completion (own_first_bonus): `place` null means the player's first
 * completion found every slot taken ("all taken"). Null without a bonus, for a repeat, or for anyone else's.
 */
export type OwnFirstBonus = Readonly<{ points: number; place: number | null; slots: number }>;

export async function firstBonusPaid(
  client: PoolClient,
  completionId: string,
): Promise<OwnFirstBonus | null> {
  const { rows } = await client.query<OwnFirstBonus>("SELECT * FROM own_first_bonus($1)", [
    completionId,
  ]);
  return rows[0] ?? null;
}
