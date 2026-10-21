import type { Pool, PoolClient } from "pg";
import { addressBucket } from "#src/auth/normalize";
import type { AuthKeys } from "#src/auth/keys";
import { BUCKETS, countRecent, forget, record } from "#src/auth/throttle";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";

export type JoinDeps = Readonly<{ pool: Pool; keys: AuthKeys }>;

type Text = Readonly<{ ar: string | null; en: string | null }>;

/** An event as anyone may see it before joining: no organizer, no settings, nothing about its players. */
export type PublicEvent = Readonly<{
  id: string;
  joinCode: string;
  name: Text;
  venue: Text;
  kind: string;
  timezone: string;
  startsAt: Date;
  endsAt: Date;
  statusNow: "scheduled" | "live" | "ended";
}>;

/** The join card's event: also its access type and how it may be joined. */
export type CardEvent = PublicEvent &
  Readonly<{ access: "public" | "unlisted" | "private"; joinMethods: readonly string[] }>;

export type PublicQuest = Readonly<{
  id: string;
  title: Text;
  description: Text;
  type: string;
  points: number;
  opensAt: Date | null;
  closesAt: Date | null;
}>;
export type PublicCategory = Readonly<{ id: string; name: Text; quests: PublicQuest[] }>;

export type JoinVia = "code" | "qr" | "link" | "public_list";

export type JoinOutcome =
  | Readonly<{
      kind: "joined" | "already";
      enrollmentId: string;
      eventId: string;
      status: "active" | "pending";
    }>
  | Readonly<{ kind: "not_found" | "ended" | "method_off" | "not_allowed" }>;

export type MyEvent = PublicEvent &
  Readonly<{ status: "active" | "pending"; score: number; balance: number }>;

/**
 * Wrong join codes allowed in 10 minutes (T-111): per address, wide enough that one person at a venue's shared address
 * cannot lock the door for everyone (60 a window is about 0.1 lucky hits a day at 10,000 live events); per signed-in
 * player, tight.
 */
export const JOIN_CODE_MISSES = { perAddress: 60, perPlayer: 20, windowSeconds: 600 } as const;

type Budget = Readonly<{ key: Buffer; max: number }>;

type Throttled = Readonly<{ kind: "throttled"; retryAfterSeconds: number }>;

const EVENT_COLUMNS = `id, join_code, name_ar, name_en, venue_ar, venue_en, kind, timezone, starts_at, ends_at,
  status_now`;

type EventRow = Readonly<{
  id: string;
  join_code: string;
  name_ar: string | null;
  name_en: string | null;
  venue_ar: string | null;
  venue_en: string | null;
  kind: string;
  timezone: string;
  starts_at: Date;
  ends_at: Date;
  status_now: PublicEvent["statusNow"];
}>;

const toEvent = (row: EventRow): PublicEvent => ({
  id: row.id,
  joinCode: row.join_code,
  name: { ar: row.name_ar, en: row.name_en },
  venue: { ar: row.venue_ar, en: row.venue_en },
  kind: row.kind,
  timezone: row.timezone,
  startsAt: row.starts_at,
  endsAt: row.ends_at,
  statusNow: row.status_now,
});

/** Runs a read with no request context: the anonymous seat, which reaches events only through the definers. */
const anonymously = <T>(pool: Pool, work: (client: PoolClient) => Promise<T>) =>
  withConnection(pool, (client) => withRequestContext(client, {}, () => work(client)));

/**
 * Looks a code up against a budget of wrong codes. Each key's miss is recorded before the lookup, in its own
 * statement, and counted after: a burst of parallel guesses each sees every miss committed before its count, so no
 * more than the budget get through, and no lock makes a crowd at one venue address wait or fail. A code that exists
 * gives its reservation back; once a key is over budget every lookup is refused, real codes too. A lookup that fails
 * (the database is down) keeps its reservation: it fails closed and counts as a miss, on purpose.
 */
async function withMissBudget<T>(
  deps: JoinDeps,
  budgets: readonly Budget[],
  lookup: () => Promise<T | null>,
): Promise<T | null | Throttled> {
  const held = await withConnection(deps.pool, async (client) => {
    const reserved: { key: Buffer; at: string }[] = [];
    for (const { key } of budgets) {
      reserved.push({ key, at: await record(client, BUCKETS.joinCodeMiss, key) });
    }
    return reserved;
  });
  const giveBack = () =>
    withConnection(deps.pool, async (client) => {
      for (const { key, at } of held) {
        await forget(client, BUCKETS.joinCodeMiss, key, at);
      }
    });
  const windows = await withConnection(deps.pool, (client) =>
    Promise.all(
      budgets.map(async ({ key, max }) => ({
        max,
        window: await countRecent(
          client,
          BUCKETS.joinCodeMiss,
          key,
          JOIN_CODE_MISSES.windowSeconds,
        ),
      })),
    ),
  );
  const over = windows.filter(({ max, window }) => window.count > max).map(({ window }) => window);
  if (over.length > 0) {
    await giveBack();
    return {
      kind: "throttled",
      retryAfterSeconds: Math.max(...over.map((w) => w.retryAfterSeconds)),
    };
  }
  const found = await lookup();
  if (found !== null) {
    await giveBack();
  }
  return found;
}

const addressBudget = (deps: JoinDeps, address: string): Budget => ({
  key: deps.keys.addressKey(addressBucket(address)),
  max: JOIN_CODE_MISSES.perAddress,
});

export const isThrottled = (value: unknown): value is Throttled =>
  typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "throttled";

/** The public list: public events that list themselves, scheduled or live, soonest first (FR-104). */
export async function listPublicEvents(
  deps: JoinDeps,
  afterId: string | null,
  limit: number,
): Promise<PublicEvent[]> {
  return anonymously(deps.pool, async (client) => {
    const { rows } = await client.query<EventRow>(
      `SELECT ${EVENT_COLUMNS} FROM public_events($1, $2)`,
      [afterId, limit],
    );
    return rows.map(toEvent);
  });
}

async function readCard(client: PoolClient, code: string): Promise<CardEvent | null> {
  const { rows } = await client.query<
    EventRow & { access: CardEvent["access"]; join_methods: string[] }
  >(`SELECT ${EVENT_COLUMNS}, access, join_methods FROM public_event($1)`, [code]);
  const row = rows[0];
  return row === undefined
    ? null
    : { ...toEvent(row), access: row.access, joinMethods: row.join_methods };
}

/** One event by its code for the join card, any access type (FR-105), against the address's budget of wrong codes. */
export async function findByCode(
  deps: JoinDeps,
  address: string,
  code: string,
): Promise<CardEvent | null | Throttled> {
  return withMissBudget(deps, [addressBudget(deps, address)], () =>
    anonymously(deps.pool, (client) => readCard(client, code)),
  );
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
  opens_at: Date | null;
  closes_at: Date | null;
}>;

function groupQuests(rows: readonly QuestRow[]): PublicCategory[] {
  const categories = new Map<string, { id: string; name: Text; quests: PublicQuest[] }>();
  for (const row of rows) {
    const category = categories.get(row.category_id) ?? {
      id: row.category_id,
      name: { ar: row.category_name_ar, en: row.category_name_en },
      quests: [],
    };
    category.quests.push({
      id: row.quest_id,
      title: { ar: row.title_ar, en: row.title_en },
      description: { ar: row.description_ar, en: row.description_en },
      type: row.type,
      points: row.points,
      opensAt: row.opens_at,
      closesAt: row.closes_at,
    });
    categories.set(row.category_id, category);
  }
  return [...categories.values()];
}

/**
 * An event's quests before sign-in (FR-111): `private` when the code names a private event (its quests need
 * membership), null when it names no event, against the address's budget of wrong codes.
 */
export async function questsByCode(
  deps: JoinDeps,
  address: string,
  code: string,
): Promise<PublicCategory[] | "private" | null | Throttled> {
  return withMissBudget(deps, [addressBudget(deps, address)], () =>
    anonymously(deps.pool, async (client) => {
      const card = await readCard(client, code);
      if (card === null) {
        return null;
      }
      if (card.access === "private") {
        return "private" as const;
      }
      const { rows } = await client.query<QuestRow>(
        `SELECT category_id, category_name_ar, category_name_en, quest_id, title_ar, title_en, description_ar,
                description_en, type, points, opens_at, closes_at
         FROM public_event_quests($1)`,
        [code],
      );
      return groupQuests(rows);
    }),
  );
}

type JoinRow = Readonly<{
  outcome: "joined" | "already" | "not_found" | "ended" | "method_off" | "not_allowed";
  enrollment_id: string | null;
  event_id: string | null;
  status: "active" | "pending" | null;
}>;

/** Joins the player to the event with this code (FR-101 to 105), against their and their address's wrong codes. */
export async function joinByCode(
  deps: JoinDeps,
  request: Readonly<{
    playerId: string;
    address: string;
    code: string;
    via: JoinVia;
    cardVersion: string;
  }>,
): Promise<JoinOutcome | Throttled> {
  const budgets = [
    addressBudget(deps, request.address),
    { key: deps.keys.playerKey(request.playerId), max: JOIN_CODE_MISSES.perPlayer },
  ];
  const result = await withMissBudget(deps, budgets, async () => {
    const row = await withConnection(deps.pool, (client) =>
      withRequestContext(client, { playerId: request.playerId }, async () => {
        const { rows } = await client.query<JoinRow>(
          "SELECT outcome, enrollment_id, event_id, status FROM join_event($1, $2, $3)",
          [request.code, request.via, request.cardVersion],
        );
        return rows[0];
      }),
    );
    return row === undefined || row.outcome === "not_found" ? null : row;
  });
  if (isThrottled(result)) {
    return result;
  }
  if (result === null) {
    return { kind: "not_found" };
  }
  if (result.outcome === "joined" || result.outcome === "already") {
    const { enrollment_id: enrollmentId, event_id: eventId, status } = result;
    // Stryker disable next-line ConditionalExpression,LogicalOperator,BlockStatement: unreachable: join_event returns all three with a member
    if (enrollmentId === null || eventId === null || status === null) {
      throw new Error(
        `join_event answered ${result.outcome} without an enrollment; check migration 0018`,
      );
    }
    return { kind: result.outcome, enrollmentId, eventId, status };
  }
  return { kind: result.outcome };
}

/** The player's events for the switcher (FR-122): active and pending, newest join first, read under their own rules. */
export async function myEvents(deps: JoinDeps, playerId: string): Promise<MyEvent[]> {
  return withConnection(deps.pool, (client) =>
    withRequestContext(client, { playerId }, async () => {
      const { rows } = await client.query<
        EventRow & { status: MyEvent["status"]; score: string; balance: string }
      >(
        `SELECT e.id, e.join_code, e.name_ar, e.name_en, e.venue_ar, e.venue_en, e.kind, e.timezone, e.starts_at,
                e.ends_at, event_status_now(e.status, e.starts_at, e.ends_at) AS status_now, n.status, n.score,
                n.balance
         FROM enrollment n JOIN event e ON e.id = n.event_id
         WHERE n.player_id = $1 AND n.status IN ('active', 'pending')
         ORDER BY n.joined_at DESC, n.id`,
        [playerId],
      );
      return rows.map((row) => ({
        ...toEvent(row),
        status: row.status,
        score: Number(row.score),
        balance: Number(row.balance),
      }));
    }),
  );
}

export type LeaveOutcome = "left" | "not_found" | "cannot_leave";

/**
 * Leaves an event (FR-1703): an active or pending member becomes `left`, under the player's own rules; leaving again
 * is the same answer. A banned or removed player cannot leave, which would let them join again (T-208).
 */
export async function leaveEvent(
  deps: JoinDeps,
  playerId: string,
  eventId: string,
): Promise<LeaveOutcome> {
  return withConnection(deps.pool, (client) =>
    withRequestContext(client, { playerId }, async () => {
      const left = await client.query(
        `UPDATE enrollment SET status = 'left'
         WHERE event_id = $1 AND player_id = $2 AND status IN ('active', 'pending') RETURNING id`,
        [eventId, playerId],
      );
      // The answer describes what this request did: a ban landing just after it does not turn it into a refusal.
      if (left.rowCount === 1) {
        return "left";
      }
      const { rows } = await client.query<{ status: string }>(
        "SELECT status FROM enrollment WHERE event_id = $1 AND player_id = $2",
        [eventId, playerId],
      );
      const status = rows[0]?.status;
      if (status === undefined) {
        return "not_found";
      }
      return status === "left" ? "left" : "cannot_leave";
    }),
  );
}
