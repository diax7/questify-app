import type { JoinFieldKind } from "@questify/shared";
import type { Pool, PoolClient } from "pg";
import { isEventFull } from "#src/activation/activation";
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

/** A join field as the card shows it (FR-130): a custom one carries its own label. */
export type JoinFieldView = Readonly<{
  id: string;
  kind: JoinFieldKind;
  label: Text;
  required: boolean;
}>;

/** What an event asks and checks at the join (T-212): its fields, its locks and its welcome amount. */
export type JoinRules = Readonly<{
  fields: readonly JoinFieldView[];
  guestListOnly: boolean;
  emailDomains: readonly string[];
  welcomePoints: number | null;
}>;

/** The join card's event: also its access type, how it may be joined and its join rules. */
export type CardEvent = PublicEvent &
  Readonly<{
    access: "public" | "unlisted" | "private";
    joinMethods: readonly string[];
    join: JoinRules;
  }>;

/** An invitation (FR-133): an event whose guest list holds the player, with what its card needs. No join code. */
export type Invitation = Omit<PublicEvent, "joinCode"> &
  Readonly<{ access: CardEvent["access"]; join: JoinRules }>;

/** The answers given on the card: field id to text, already trimmed and without blanks. */
export type JoinAnswers = Readonly<Record<string, string>>;

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
      /** The welcome points this join granted (FR-136); 0 when none. */
      welcome: number;
    }>
  | Readonly<{ kind: "not_found" | "ended" | "method_off" | "not_allowed" | "invite_only" | "full" }>
  | Readonly<{ kind: "domain_required"; domains: readonly string[] }>
  /** An answer is missing or not valid: the field it is, or null when the answers were not an object. */
  | Readonly<{ kind: "invalid_answers"; field: string | null }>;

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

type FieldJson = Readonly<{
  id: string;
  kind: JoinFieldKind;
  labelAr: string | null;
  labelEn: string | null;
  required: boolean;
}>;

type RulesRow = Readonly<{
  guest_list_only: boolean;
  email_domains: string[];
  welcome_points: number | null;
  fields: FieldJson[];
}>;

/** The rules as migration 0028's definers return them (`event_join_fields_json`). */
export const rulesOf = (row: RulesRow): JoinRules => ({
  fields: row.fields.map((field) => ({
    id: field.id,
    kind: field.kind,
    label: { ar: field.labelAr, en: field.labelEn },
    required: field.required,
  })),
  guestListOnly: row.guest_list_only,
  emailDomains: row.email_domains,
  welcomePoints: row.welcome_points,
});

async function readRules(client: PoolClient, code: string): Promise<JoinRules | undefined> {
  const { rows } = await client.query<RulesRow>(
    "SELECT guest_list_only, email_domains, welcome_points, fields FROM public_event_join_rules($1)",
    [code],
  );
  const row = rows[0];
  return row === undefined ? undefined : rulesOf(row);
}

async function readCard(client: PoolClient, code: string): Promise<CardEvent | null> {
  const { rows } = await client.query<
    EventRow & { access: CardEvent["access"]; join_methods: string[] }
  >(`SELECT ${EVENT_COLUMNS}, access, join_methods FROM public_event($1)`, [code]);
  const row = rows[0];
  const join = row === undefined ? undefined : await readRules(client, code);
  // Stryker disable next-line ConditionalExpression,LogicalOperator: both definers read the same event by the same code in one transaction
  return row === undefined || join === undefined
    ? null
    : { ...toEvent(row), access: row.access, joinMethods: row.join_methods, join };
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
  outcome:
    | "joined"
    | "already"
    | "not_found"
    | "ended"
    | "method_off"
    | "not_allowed"
    | "invite_only"
    | "domain_required"
    | "full";
  enrollment_id: string | null;
  event_id: string | null;
  status: "active" | "pending" | null;
  welcome: number;
}>;

/** The database refused the answers (JA422): its DETAIL names the field (`field:<id>`) or says `shape`. */
type AnswersRefused = Readonly<{ outcome: "invalid_answers"; field: string | null }>;

const FIELD_DETAIL = /^field:(.+)$/;

function answersRefused(error: unknown): AnswersRefused | undefined {
  const pg = error as { code?: unknown; detail?: unknown };
  if (pg.code !== "JA422") {
    return undefined;
  }
  const match = FIELD_DETAIL.exec(String(pg.detail));
  return { outcome: "invalid_answers", field: match?.[1] ?? null };
}

/**
 * Runs one join definer for the player. A refusal of the answers rolls the transaction back and comes back as a value,
 * so a code that exists is never counted as a wrong one because of what was typed in a field.
 */
async function runJoin(
  deps: JoinDeps,
  playerId: string,
  sql: string,
  values: readonly unknown[],
): Promise<JoinRow | AnswersRefused | undefined> {
  try {
    return await withConnection(deps.pool, (client) =>
      withRequestContext(client, { playerId }, async () => {
        const { rows } = await client.query<JoinRow>(sql, [...values]);
        return rows[0];
      }),
    );
  } catch (error) {
    // A hard player limit that is full refuses the seat inside the definer (migration 0027, T-210).
    if (isEventFull(error)) {
      return { outcome: "full", enrollment_id: null, event_id: null, status: null, welcome: 0 };
    }
    const refused = answersRefused(error);
    if (refused === undefined) {
      throw error;
    }
    return refused;
  }
}

function outcomeOf(row: JoinRow | AnswersRefused, domains: readonly string[]): JoinOutcome {
  switch (row.outcome) {
    case "invalid_answers":
      return { kind: "invalid_answers", field: row.field };
    case "domain_required":
      return { kind: "domain_required", domains };
    case "joined":
    case "already": {
      const { enrollment_id: enrollmentId, event_id: eventId, status } = row;
      // Stryker disable next-line ConditionalExpression,LogicalOperator,BlockStatement: unreachable: join_core returns all three with a member
      if (enrollmentId === null || eventId === null || status === null) {
        throw new Error(`join answered ${row.outcome} without an enrollment; check migration 0028`);
      }
      return { kind: row.outcome, enrollmentId, eventId, status, welcome: row.welcome };
    }
    default:
      return { kind: row.outcome };
  }
}

const JOIN_COLUMNS = "outcome, enrollment_id, event_id, status, welcome";

/**
 * Joins the player to the event with this code (FR-101 to 105, FR-130, FR-134, FR-135), with the card's answers,
 * against their and their address's wrong codes.
 */
export async function joinByCode(
  deps: JoinDeps,
  request: Readonly<{
    playerId: string;
    address: string;
    code: string;
    via: JoinVia;
    cardVersion: string;
    answers: JoinAnswers;
  }>,
): Promise<JoinOutcome | Throttled> {
  const budgets = [
    addressBudget(deps, request.address),
    { key: deps.keys.playerKey(request.playerId), max: JOIN_CODE_MISSES.perPlayer },
  ];
  const result = await withMissBudget(deps, budgets, async () => {
    const row = await runJoin(
      deps,
      request.playerId,
      `SELECT ${JOIN_COLUMNS} FROM join_event($1, $2, $3, $4::jsonb)`,
      [request.code, request.via, request.cardVersion, JSON.stringify(request.answers)],
    );
    return row === undefined || row.outcome === "not_found" ? null : row;
  });
  if (isThrottled(result)) {
    return result;
  }
  if (result === null) {
    return { kind: "not_found" };
  }
  const domains =
    result.outcome === "domain_required"
      ? ((await anonymously(deps.pool, (client) => readRules(client, request.code)))
          ?.emailDomains ?? [])
      : [];
  return outcomeOf(result, domains);
}

/**
 * Joins an invited player without a code (FR-133): an event whose guest list holds one of their verified identifiers.
 * Any other event is not found, the same answer for every id.
 */
export async function joinInvited(
  deps: JoinDeps,
  request: Readonly<{
    playerId: string;
    eventId: string;
    cardVersion: string;
    answers: JoinAnswers;
  }>,
): Promise<JoinOutcome> {
  const row = await runJoin(
    deps,
    request.playerId,
    `SELECT ${JOIN_COLUMNS} FROM join_invited($1, $2, $3::jsonb)`,
    [request.eventId, request.cardVersion, JSON.stringify(request.answers)],
  );
  // Stryker disable next-line ConditionalExpression: unreachable: join_invited always returns one row
  if (row === undefined) {
    return { kind: "not_found" };
  }
  return outcomeOf(row, []);
}

type InvitationRow = Omit<EventRow, "join_code"> & RulesRow & { access: CardEvent["access"] };

/**
 * The player's invitations (FR-133), soonest first: what the "You're invited" cards show. A guest passes the guest-list
 * and domain locks (ADR-145), so the cards show neither.
 */
export async function myInvitations(deps: JoinDeps, playerId: string): Promise<Invitation[]> {
  return withConnection(deps.pool, (client) =>
    withRequestContext(client, { playerId }, async () => {
      const { rows } = await client.query<InvitationRow>(
        `SELECT id, name_ar, name_en, venue_ar, venue_en, kind, timezone, starts_at, ends_at, status_now, access,
                false AS guest_list_only, '{}'::text[] AS email_domains, welcome_points, fields
         FROM my_invitations()`,
      );
      return rows.map((row) => {
        const { joinCode: _code, ...event } = toEvent({ ...row, join_code: "" });
        return { ...event, access: row.access, join: rulesOf(row) };
      });
    }),
  );
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
