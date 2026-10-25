import { EMPTY_EQUIPMENT, type Equipment } from "@questify/shared";
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

/** Only the username and avatar of another player are ever shown (FR-120). */
export type RankingRow = Readonly<{
  rank: number;
  username: string;
  avatar: string;
  equipment: Equipment;
  score: number;
  isMe: boolean;
}>;

/**
 * The top 10 and the reader's own place (ADR-052); `me` is null when the reader is not ranked. `today` says whether the
 * event has a today's ranking now (multi-day and live, T-216); the route also applies the owner's switch.
 */
export type RankingView = Readonly<{
  rows: readonly RankingRow[];
  me: Readonly<{
    rank: number;
    username: string;
    avatar: string;
    equipment: Equipment;
    score: number;
  }> | null;
  total: number;
  today: boolean;
}>;

/** The whole event's ranking, or today's: points earned since the event day started (FR-610, ADR-166). */
export type RankingScope = "event" | "today";

export type Ranking = Readonly<{
  /** Copies the player's place after their completion committed; their rank, or null (not ranked, Redis failed). */
  afterCompletion: (playerId: string, completionId: string) => Promise<number | null>;
  /** The event's ranking (or today's) as the player sees it; `not_enrolled`; `today_off` when there is no today's. */
  read: (
    eventId: string,
    playerId: string,
    scope?: RankingScope,
  ) => Promise<RankingView | "not_enrolled" | "today_off">;
  /** Rebuilds the events marked for repair, and every live event whose copy is older than the backstop interval. */
  repairDue: () => Promise<void>;
}>;

const TOP = 10;
const CLAIM = 20;
/** How often the backstop rebuilds each live event's copy: a bound on any change whose repair signal was lost. */
const BACKSTOP_MS = 5 * 60 * 1000;

const reasonOf = (error: unknown): string => (error instanceof Error ? error.name : "unknown");

/** One board: the whole event's, or one event day's (`day` as YYYY-MM-DD in the event's calendar). */
type Board = Readonly<{ eventId: string; day: string | undefined }>;

/** Each event day's board is a copy of its own in the same store, so a new day starts from an empty board. */
const keyOf = (board: Board): string =>
  board.day === undefined ? board.eventId : `${board.eventId}/${board.day}`;

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

function rebuild(deps: RankingDeps, store: RankingStore, board: Board) {
  return store.rebuild(keyOf(board), () =>
    inContext(deps, {}, async (client) => {
      const { rows } = await client.query<{
        enrollment_id: string;
        score: string;
        score_version: string;
        ranked: boolean;
      }>(
        board.day === undefined
          ? "SELECT * FROM ranking_entries($1)"
          : "SELECT * FROM ranking_day_entries($1, $2::date)",
        board.day === undefined ? [board.eventId] : [board.eventId, board.day],
      );
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
  board: Board,
  playerId: string,
  me: Own,
): Promise<BoardView> {
  const daily = board.day !== undefined;
  return inContext(deps, { playerId }, async (client) => {
    const top = await client.query<{
      enrollment_id: string;
      username: string;
      avatar: string;
      equipment: Equipment;
      score: string;
    }>(
      daily
        ? "SELECT enrollment_id, username, avatar, equipment, score FROM ranking_day_top($1, $2)"
        : "SELECT enrollment_id, username, avatar, equipment, score FROM ranking_top($1, $2)",
      [board.eventId, TOP],
    );
    const { rows } = await client.query<{ place: string | null; total: string }>(
      daily
        ? "SELECT place, total FROM ranking_day_position($1)"
        : "SELECT place, total FROM ranking_position($1)",
      [board.eventId],
    );
    const position = rows[0];
    return {
      rows: top.rows.map((row, index) => ({
        rank: index + 1,
        username: row.username,
        avatar: row.avatar,
        equipment: row.equipment,
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

type Named = ReadonlyMap<
  string,
  Readonly<{
    username: string | null;
    avatar: string | null;
    equipment: Equipment | null;
    ranked: boolean;
  }>
>;

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
        avatar: string | null;
        equipment: Equipment | null;
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
  asked: Readonly<{ board: Board; playerId: string; me: Own }>,
): Promise<BoardView | "not_enrolled" | undefined> {
  const { board, playerId, me } = asked;
  const { eventId } = board;
  const key = keyOf(board);
  let copy = await store.read(key, TOP, me.enrollmentId);
  if (copy === undefined) {
    await rebuild(deps, store, board);
    copy = await store.read(key, TOP, me.enrollmentId);
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
      await store.remove(key, row.enrollmentId, row.version);
    }
    await mark(deps, eventId);
    return undefined;
  }
  return viewOf(copy, named, me);
}

async function ownIn(
  client: PoolClient,
  eventId: string,
  playerId: string,
): Promise<Own | undefined> {
  const { rows } = await client.query<{
    id: string;
    score: string;
    username: string;
    avatar: string;
    equipment: Equipment;
  }>(
    `SELECT e.id, e.score, p.username, p.avatar, c.equipment FROM enrollment e JOIN player p ON p.id = e.player_id CROSS JOIN own_equipment() c
     WHERE e.event_id = $1 AND e.player_id = $2 AND e.status = 'active'`,
    [eventId, playerId],
  );
  const row = rows[0];
  return row === undefined
    ? undefined
    : {
        enrollmentId: row.id,
        score: Number(row.score),
        username: row.username,
        avatar: row.avatar,
        equipment: row.equipment,
      };
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
    await rebuild(deps, store, { eventId: entry.event_id, day: undefined });
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
    const place = entry === undefined ? null : await placeAfter(deps, store, entry);
    await dayAfter(deps, store, playerId, completionId);
    return place;
  } catch (error) {
    deps.log("warn", { event: "ranking.write_failed", reason: reasonOf(error) });
    if (entry !== undefined) {
      await mark(deps, entry.event_id);
    }
    return null;
  }
}

/**
 * Copies the completion into its event day's board, for a multi-day event (nothing otherwise). A failure here is
 * logged and the event marked; it never takes the overall place from the answer.
 */
async function dayAfter(
  deps: RankingDeps,
  store: RankingStore,
  playerId: string,
  completionId: string,
): Promise<void> {
  let entry: (EntryRow & Readonly<{ day: string }>) | undefined;
  try {
    entry = await inContext(deps, { playerId }, async (client) => {
      const { rows } = await client.query<EntryRow & { day: string }>(
        `SELECT event_id, day::text AS day, enrollment_id, score, score_version, ranked
         FROM ranking_day_entry_of($1)`,
        [completionId],
      );
      return rows[0];
    });
    // Stryker disable next-line ConditionalExpression: equivalent: the function gives a row only with a version
    if (entry === undefined || entry.score_version === null) {
      return;
    }
    const key = keyOf({ eventId: entry.event_id, day: entry.day });
    const version = BigInt(entry.score_version);
    await (entry.ranked
      ? store.upsert(key, {
          enrollmentId: entry.enrollment_id,
          score: BigInt(entry.score),
          version,
        })
      : store.remove(key, entry.enrollment_id, version));
  } catch (error) {
    deps.log("warn", { event: "ranking.day_write_failed", reason: reasonOf(error) });
    if (entry !== undefined) {
      await mark(deps, entry.event_id);
    }
  }
}

type Today = Readonly<{ day: string; available: boolean; myScore: number }>;

/** The event's day now and whether it has a today's ranking (multi-day and live); undefined for a stranger. */
async function todayIn(client: PoolClient, eventId: string): Promise<Today | undefined> {
  const { rows } = await client.query<{
    day: string;
    multi_day: boolean;
    live: boolean;
    my_score: string | null;
  }>("SELECT day::text AS day, multi_day, live, my_score FROM ranking_today($1)", [eventId]);
  const row = rows[0];
  if (row === undefined) {
    return undefined;
  }
  const today: Today = {
    day: row.day,
    available: row.multi_day && row.live,
    myScore: Number(row.my_score ?? 0),
  };
  return today;
}

async function boardView(
  deps: RankingDeps,
  asked: Readonly<{ board: Board; playerId: string; me: Own }>,
): Promise<BoardView | "not_enrolled"> {
  const { store } = deps;
  if (store !== undefined) {
    try {
      const view = await fromRedis(deps, store, asked);
      if (view !== undefined) {
        return view;
      }
    } catch (error) {
      deps.log("warn", { event: "ranking.read_failed", reason: reasonOf(error) });
      await mark(deps, asked.board.eventId);
    }
  }
  return fromPostgres(deps, asked.board, asked.playerId, asked.me);
}

async function read(
  deps: RankingDeps,
  eventId: string,
  playerId: string,
  scope: RankingScope,
): Promise<RankingView | "not_enrolled" | "today_off"> {
  const { own, today } = await inContext(deps, { playerId }, async (client) => {
    const mine = await ownIn(client, eventId, playerId);
    return { own: mine, today: mine === undefined ? undefined : await todayIn(client, eventId) };
  });
  if (own === undefined || today === undefined) {
    return "not_enrolled";
  }
  const daily = scope === "today";
  if (daily && !today.available) {
    return "today_off";
  }
  const view = await boardView(deps, {
    board: { eventId, day: daily ? today.day : undefined },
    playerId,
    me: daily ? { ...own, score: today.myScore } : own,
  });
  return view === "not_enrolled" ? view : { ...view, today: today.available };
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
      if ((await rebuildEvent(deps, store, eventId)) === "busy") {
        // Another rebuild holds the lock and may have read PostgreSQL before this event's change: try again next tick.
        await mark(deps, eventId);
      }
    } catch (error) {
      deps.log("warn", { event: "ranking.rebuild_failed", reason: reasonOf(error) });
      await mark(deps, eventId);
    }
  }
}

/** Rebuilds the event's copy and, while the event is multi-day and live, today's copy with it. */
async function rebuildEvent(
  deps: RankingDeps,
  store: RankingStore,
  eventId: string,
): Promise<"rebuilt" | "busy"> {
  const whole = await rebuild(deps, store, { eventId, day: undefined });
  const today = await inContext(deps, {}, (client) => todayIn(client, eventId));
  if (today === undefined || !today.available) {
    return whole;
  }
  const daily = await rebuild(deps, store, { eventId, day: today.day });
  return whole === "busy" || daily === "busy" ? "busy" : "rebuilt";
}

/** The ranking of one event, read from Redis when it can and from PostgreSQL (the same order) when it cannot. */
export function createRanking(deps: RankingDeps): Ranking {
  // Stryker disable next-line ObjectLiteral: equivalent: an undefined start makes the first comparison NaN, which also means 'run the backstop now'
  const clock = { lastBackstop: 0 };
  return {
    afterCompletion: (playerId, completionId) => afterCompletion(deps, playerId, completionId),
    read: (eventId, playerId, scope = "event") => read(deps, eventId, playerId, scope),
    repairDue: () => repairDue(deps, clock),
  };
}

type Own = Readonly<{
  enrollmentId: string;
  score: number;
  username: string;
  avatar: string;
  equipment: Equipment;
}>;

type BoardView = Omit<RankingView, "today">;

const meOf = (me: Own, place: number | null): RankingView["me"] =>
  place === null
    ? null
    : {
        rank: place,
        username: me.username,
        avatar: me.avatar,
        equipment: me.equipment,
        score: me.score,
      };

function viewOf(copy: Read, named: Named, me: Own): BoardView {
  return {
    rows: copy.top.map((row, index) => ({
      rank: index + 1,
      username: named.get(row.enrollmentId)?.username ?? "",
      avatar: named.get(row.enrollmentId)?.avatar ?? "",
      equipment: named.get(row.enrollmentId)?.equipment ?? EMPTY_EQUIPMENT,
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
