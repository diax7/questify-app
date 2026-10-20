import type { Pool, PoolClient } from "pg";
import { withConnection } from "#src/db/connection";
import { withRequestContext, type RequestContext } from "#src/db/context";
import type { Ranked, RankingStore, Read } from "#src/ranking/store";

export type RankingLog = (
  level: "info" | "warn" | "error",
  fields: Readonly<Record<string, string | number>>,
) => void;

export type RankingDeps = Readonly<{
  pool: Pool;
  /** The Redis copy; without one (development, tests without Redis) every read comes from PostgreSQL. */
  store: RankingStore | undefined;
  log: RankingLog;
}>;

export type RankingRow = Readonly<{ rank: number; username: string; score: number; isMe: boolean }>;

/** The top 10 and the reader's own place (ADR-052); `me` is null when the reader is not ranked. */
export type RankingView = Readonly<{
  rows: readonly RankingRow[];
  me: Readonly<{ rank: number; username: string; score: number }> | null;
  total: number;
}>;

export type Ranking = Readonly<{
  /** Copies the player's place after their completion committed; their rank, or null (not ranked, Redis failed). */
  afterCompletion: (playerId: string, completionId: string) => Promise<number | null>;
  /** The event's ranking as the player sees it, or `not_enrolled`. */
  read: (eventId: string, playerId: string) => Promise<RankingView | "not_enrolled">;
  /** Rebuilds the events marked for repair, and every live event whose copy is older than the backstop interval. */
  repairDue: () => Promise<void>;
}>;

const TOP = 10;
const CLAIM = 20;
/** How often the backstop rebuilds each live event's copy: a bound on any change whose repair signal was lost. */
const BACKSTOP_MS = 5 * 60 * 1000;

const reasonOf = (error: unknown): string => (error instanceof Error ? error.name : "unknown");

const inContext = <T>(
  deps: RankingDeps,
  context: RequestContext,
  work: (client: PoolClient) => Promise<T>,
) => withConnection(deps.pool, (client) => withRequestContext(client, context, () => work(client)));

/** Marks an event for repair, always as the system: the mark must not depend on who noticed the problem. */
async function mark(deps: RankingDeps, eventId: string): Promise<void> {
  try {
    await inContext(deps, {}, (client) =>
      client.query("SELECT mark_ranking_repair($1)", [eventId]),
    );
  } catch (error) {
    deps.log("error", { event: "ranking.mark_failed", reason: reasonOf(error) });
  }
}

function rebuild(deps: RankingDeps, store: RankingStore, eventId: string) {
  return store.rebuild(eventId, () =>
    inContext(deps, {}, async (client) => {
      const { rows } = await client.query<{
        enrollment_id: string;
        score: string;
        score_version: string;
        ranked: boolean;
      }>("SELECT * FROM ranking_entries($1)", [eventId]);
      return rows.map((row) => ({
        enrollmentId: row.enrollment_id,
        score: BigInt(row.score),
        version: BigInt(row.score_version),
        ranked: row.ranked,
      }));
    }),
  );
}

function fromPostgres(
  deps: RankingDeps,
  eventId: string,
  playerId: string,
  me: Own,
): Promise<RankingView> {
  return inContext(deps, { playerId }, async (client) => {
    const top = await client.query<{ enrollment_id: string; username: string; score: string }>(
      "SELECT enrollment_id, username, score FROM ranking_top($1, $2)",
      [eventId, TOP],
    );
    const { rows } = await client.query<{ place: string | null; total: string }>(
      "SELECT place, total FROM ranking_position($1)",
      [eventId],
    );
    const position = rows[0];
    return {
      rows: top.rows.map((row, index) => ({
        rank: index + 1,
        username: row.username,
        score: Number(row.score),
        isMe: row.enrollment_id === me.enrollmentId,
      })),
      me: meOf(
        me,
        // Stryker disable next-line ConditionalExpression,LogicalOperator: unreachable: the reader's own active enrollment was found first, so ranking_position always answers one row
        position === undefined || position.place === null ? null : Number(position.place),
      ),
      // Stryker disable next-line OptionalChaining: unreachable for the same reason
      total: Number(position?.total ?? 0),
    };
  });
}

type Named = ReadonlyMap<string, Readonly<{ username: string | null; ranked: boolean }>>;

/** The rows of the top as the database sees them now, or `not_enrolled` when the reader may no longer look. */
async function rowsOf(
  deps: RankingDeps,
  eventId: string,
  playerId: string,
  top: readonly Ranked[],
): Promise<Named | "not_enrolled"> {
  try {
    return await inContext(deps, { playerId }, async (client) => {
      const { rows } = await client.query<{
        enrollment_id: string;
        username: string | null;
        ranked: boolean;
      }>("SELECT * FROM ranking_rows($1, $2)", [eventId, top.map((row) => row.enrollmentId)]);
      return new Map(rows.map((row) => [row.enrollment_id, row]));
    });
  } catch (error) {
    if ((error as { code?: unknown }).code === "QR403") {
      return "not_enrolled";
    }
    throw error;
  }
}

async function fromRedis(
  deps: RankingDeps,
  store: RankingStore,
  asked: Readonly<{ eventId: string; playerId: string; me: Own }>,
): Promise<RankingView | "not_enrolled" | undefined> {
  const { eventId, playerId, me } = asked;
  let copy = await store.read(eventId, TOP, me.enrollmentId);
  if (copy === undefined) {
    await rebuild(deps, store, eventId);
    copy = await store.read(eventId, TOP, me.enrollmentId);
  }
  if (copy === undefined) {
    return undefined;
  }
  const named = await rowsOf(deps, eventId, playerId, copy.top);
  if (named === "not_enrolled") {
    // The reader lost their place in the event between two reads: their problem, never the board's.
    return named;
  }
  const stale = copy.top.filter((row) => named.get(row.enrollmentId)?.ranked !== true);
  if (stale.length > 0) {
    // Someone in the copy is no longer ranked: take them out now and answer this time from PostgreSQL.
    for (const row of stale) {
      await store.remove(eventId, row.enrollmentId, row.version);
    }
    await mark(deps, eventId);
    return undefined;
  }
  return viewOf(copy, named, me);
}

function ownOf(deps: RankingDeps, eventId: string, playerId: string) {
  return inContext(deps, { playerId }, async (client): Promise<Own | undefined> => {
    const { rows } = await client.query<{ id: string; score: string; username: string }>(
      `SELECT e.id, e.score, p.username FROM enrollment e JOIN player p ON p.id = e.player_id
       WHERE e.event_id = $1 AND e.player_id = $2 AND e.status = 'active'`,
      [eventId, playerId],
    );
    const row = rows[0];
    return row === undefined
      ? undefined
      : { enrollmentId: row.id, score: Number(row.score), username: row.username };
  });
}

type EntryRow = Readonly<{
  event_id: string;
  enrollment_id: string;
  score: string;
  score_version: string | null;
  ranked: boolean;
}>;

async function placeAfter(
  deps: RankingDeps,
  store: RankingStore,
  entry: EntryRow,
): Promise<number | null> {
  // Stryker disable next-line ConditionalExpression: equivalent: a null version means no points, never ranked
  if (entry.score_version === null) {
    return null;
  }
  const version = BigInt(entry.score_version);
  if (!entry.ranked) {
    await store.remove(entry.event_id, entry.enrollment_id, version);
    return null;
  }
  await store.upsert(entry.event_id, {
    enrollmentId: entry.enrollment_id,
    score: BigInt(entry.score),
    version,
  });
  let copy = await store.read(entry.event_id, 0, entry.enrollment_id);
  if (copy === undefined) {
    // The event's first completion, or a lost copy: build it now so the answer carries the place.
    await rebuild(deps, store, entry.event_id);
    copy = await store.read(entry.event_id, 0, entry.enrollment_id);
  }
  return copy?.place ?? null;
}

/** Never fails the completion it follows: any problem is logged, the event marked, and the place left null. */
async function afterCompletion(
  deps: RankingDeps,
  playerId: string,
  completionId: string,
): Promise<number | null> {
  const { store } = deps;
  if (store === undefined) {
    return null;
  }
  let entry: EntryRow | undefined;
  try {
    entry = await inContext(deps, { playerId }, async (client) => {
      const { rows } = await client.query<EntryRow>("SELECT * FROM ranking_entry_of($1)", [
        completionId,
      ]);
      return rows[0];
    });
    return entry === undefined ? null : await placeAfter(deps, store, entry);
  } catch (error) {
    deps.log("warn", { event: "ranking.write_failed", reason: reasonOf(error) });
    if (entry !== undefined) {
      await mark(deps, entry.event_id);
    }
    return null;
  }
}

async function read(
  deps: RankingDeps,
  eventId: string,
  playerId: string,
): Promise<RankingView | "not_enrolled"> {
  const me = await ownOf(deps, eventId, playerId);
  if (me === undefined) {
    return "not_enrolled";
  }
  const { store } = deps;
  if (store !== undefined) {
    try {
      const view = await fromRedis(deps, store, { eventId, playerId, me });
      if (view !== undefined) {
        return view;
      }
    } catch (error) {
      deps.log("warn", { event: "ranking.read_failed", reason: reasonOf(error) });
      await mark(deps, eventId);
    }
  }
  return fromPostgres(deps, eventId, playerId, me);
}

async function repairDue(deps: RankingDeps, clock: { lastBackstop: number }): Promise<void> {
  const { store } = deps;
  if (store === undefined) {
    return;
  }
  const due = await inContext(deps, {}, async (client) => {
    const { rows } = await client.query<{ claim_ranking_repairs: string }>(
      "SELECT * FROM claim_ranking_repairs($1)",
      [CLAIM],
    );
    return rows.map((row) => row.claim_ranking_repairs);
  });
  if (Date.now() - clock.lastBackstop >= BACKSTOP_MS) {
    clock.lastBackstop = Date.now();
    due.push(...(await staleLiveEvents(deps, store)));
  }
  for (const eventId of new Set(due)) {
    try {
      if ((await rebuild(deps, store, eventId)) === "busy") {
        // Another rebuild holds the lock and may have read PostgreSQL before this event's change: try again next tick.
        await mark(deps, eventId);
      }
    } catch (error) {
      deps.log("warn", { event: "ranking.rebuild_failed", reason: reasonOf(error) });
      await mark(deps, eventId);
    }
  }
}

/** The ranking of one event, read from Redis when it can and from PostgreSQL (the same order) when it cannot. */
export function createRanking(deps: RankingDeps): Ranking {
  // Stryker disable next-line ObjectLiteral: equivalent: an undefined start makes the first comparison NaN, which also means 'run the backstop now'
  const clock = { lastBackstop: 0 };
  return {
    afterCompletion: (playerId, completionId) => afterCompletion(deps, playerId, completionId),
    read: (eventId, playerId) => read(deps, eventId, playerId),
    repairDue: () => repairDue(deps, clock),
  };
}

type Own = Readonly<{ enrollmentId: string; score: number; username: string }>;

const meOf = (me: Own, place: number | null): RankingView["me"] =>
  place === null ? null : { rank: place, username: me.username, score: me.score };

function viewOf(copy: Read, named: Named, me: Own): RankingView {
  return {
    rows: copy.top.map((row, index) => ({
      rank: index + 1,
      username: named.get(row.enrollmentId)?.username ?? "",
      score: Number(row.score),
      isMe: row.enrollmentId === me.enrollmentId,
    })),
    me: meOf(me, copy.place),
    total: copy.total,
  };
}

/** Live events whose copy is missing or older than the backstop interval (another copy of the API may have just rebuilt). */
async function staleLiveEvents(deps: RankingDeps, store: RankingStore): Promise<string[]> {
  const live = await inContext(deps, {}, async (client) => {
    const { rows } = await client.query<{ live_ranking_events: string }>(
      "SELECT * FROM live_ranking_events()",
    );
    return rows.map((row) => row.live_ranking_events);
  });
  const stale: string[] = [];
  for (const eventId of live) {
    const builtAt = await store.builtAt(eventId);
    if (builtAt === undefined || Date.now() - builtAt >= BACKSTOP_MS) {
      stale.push(eventId);
    }
  }
  return stale;
}
