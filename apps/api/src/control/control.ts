import type { Pool, PoolClient } from "pg";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import type { OrganizerContext } from "#src/organizers/store";
import type { Bilingual } from "#src/quests/store";

export type ControlDeps = Readonly<{ pool: Pool }>;

/** One completion on the feed: who, which quest, how, when. No contact detail, no points. */
export type FeedRow = Readonly<{
  id: string;
  at: string;
  questId: string;
  title: Bilingual;
  method: string;
  username: string;
  avatar: string;
}>;

/** The control room's counters (FR-1028). */
export type ControlCounts = Readonly<{
  /** Active members. */
  players: number;
  /** Members with a completion in the last 15 minutes. */
  online: number;
  /** Active rewards at or under the stock-low line. */
  lowStock: number;
  /** Open help requests plus submissions waiting for review. */
  inbox: number;
  /** Open flags. */
  flags: number;
}>;

/** Everything one poll of the control room answers. */
export type ControlView = Readonly<{
  counts: ControlCounts;
  feed: readonly FeedRow[];
  /** Players who completed each quest at least once, by quest id; a quest nobody completed has no key. */
  done: Readonly<Record<string, number>>;
  /**
   * For each skipped step (T-603b), the active players past it who have not done it: restoring it holds them again.
   * Only skipped steps have a key.
   */
  behind: Readonly<Record<string, number>>;
}>;

/** How many completions one poll lists. */
export const FEED_SIZE = 30;
/** How long one event's per-quest completions are shared among its team. */
export const DONE_CACHE_MS = 30_000;
/** Past this many entries the map is emptied rather than grown (one instance's events in half a minute). */
const MAP_CAP = 5000;

const iso = (value: unknown): string => (value instanceof Date ? value.toISOString() : "");
const textOf = (ar: unknown, en: unknown): Bilingual => ({
  ar: typeof ar === "string" ? ar : null,
  en: typeof en === "string" ? en : null,
});
const whole = (value: unknown): number => (typeof value === "number" ? value : 0);

const feedRowOf = (row: Readonly<Record<string, unknown>>): FeedRow => ({
  id: String(row["id"]),
  at: iso(row["at"]),
  questId: String(row["quest_id"]),
  title: textOf(row["title_ar"], row["title_en"]),
  method: String(row["method"]),
  username: String(row["username"]),
  avatar: String(row["avatar"]),
});

export type ControlReader = Readonly<{
  /**
   * The event's newest completions, counters and per-quest completions as the team member reads them. Undefined for
   * an event outside the member's organizer or event limit (the database raises AN404).
   */
  read: (team: OrganizerContext, eventId: string) => Promise<ControlView | undefined>;
}>;

type PerQuest = Readonly<Pick<ControlView, "done" | "behind">>;
type Kept = Readonly<{ until: number; done: Promise<PerQuest> }>;

async function readDone(client: PoolClient, eventId: string): Promise<PerQuest> {
  const { rows } = await client.query("SELECT * FROM control_done($1)", [eventId]);
  return {
    done: Object.fromEntries(
      rows
        .filter((row) => whole(row["done"]) > 0)
        .map((row) => [String(row["quest_id"]), whole(row["done"])]),
    ),
    behind: Object.fromEntries(
      rows
        .filter((row) => row["skipped"] === true)
        .map((row) => [String(row["quest_id"]), whole(row["behind"])]),
    ),
  };
}

/**
 * Reads the control room through its three doors (`control_feed`, `control_counts`, `control_done`, migration 0096),
 * each of which checks the team member's organizer and event limit itself. The per-quest completions walk every first
 * completion of the event, so one answer per event is kept for 30 seconds and shared, concurrent callers included; it
 * is read only after the feed has been answered for this member, so the cache never serves a caller the database
 * refused. A failed read is forgotten at once.
 */
export function createControlReader(
  deps: ControlDeps,
  now: () => number = Date.now,
): ControlReader {
  const kept = new Map<string, Kept>();
  const doneOf = (client: PoolClient, eventId: string) => {
    const found = kept.get(eventId);
    if (found !== undefined && found.until > now()) {
      return found.done;
    }
    if (kept.size >= MAP_CAP) {
      kept.clear();
    }
    const done = readDone(client, eventId);
    kept.set(eventId, { until: now() + DONE_CACHE_MS, done });
    done.catch(() => {
      if (kept.get(eventId)?.done === done) {
        kept.delete(eventId);
      }
    });
    return done;
  };
  return {
    read: async (team, eventId) => {
      try {
        return await withConnection(deps.pool, (client) =>
          withRequestContext(
            client,
            { organizerId: team.organizerId, staffUserId: team.staffUserId },
            async () => {
              const { rows: feed } = await client.query("SELECT * FROM control_feed($1, $2)", [
                eventId,
                FEED_SIZE,
              ]);
              const { rows: counts } = await client.query("SELECT * FROM control_counts($1)", [
                eventId,
              ]);
              const count = counts[0] ?? {};
              return {
                counts: {
                  players: whole(count["players"]),
                  online: whole(count["online"]),
                  lowStock: whole(count["low_stock"]),
                  inbox: whole(count["inbox"]),
                  flags: whole(count["flags"]),
                },
                feed: feed.map(feedRowOf),
                ...(await doneOf(client, eventId)),
              };
            },
          ),
        );
      } catch (error) {
        if ((error as { code?: string }).code === "AN404") {
          return undefined;
        }
        throw error;
      }
    },
  };
}
