import type { Pool, PoolClient } from "pg";
import type { Caller } from "#src/auth/sign-in";
import { withConnection } from "#src/db/connection";
import { withRequestContext, type RequestContext } from "#src/db/context";
import { JOIN_CODE_MISSES, addressBudget, withMissBudget, type JoinDeps } from "#src/join/join";
import type { OrganizerContext } from "#src/organizers/store";
import {
  cardOf,
  countsOf,
  isOpen,
  newRehearsalCode,
  rehearsalRefusalOf,
  type CardRow,
  type RehearsalCard,
  type RehearsalCounts,
  type RehearsalRefusal,
} from "#src/rehearsal/rehearsal";

type Text = Readonly<{ ar: string | null; en: string | null }>;

/** The event a rehearsal code opens, as the player's rehearsal card shows it. */
export type RehearsalEvent = Readonly<{
  id: string;
  name: Text;
  venue: Text;
  kind: string;
  timezone: string;
  startsAt: Date | null;
  endsAt: Date | null;
  statusNow: "draft" | "scheduled";
}>;

export type RehearsalJoin =
  | Readonly<{ kind: "joined" | "already"; enrollmentId: string; eventId: string }>
  | Readonly<{ kind: "already_player" | "not_allowed" | "full" | "closed" }>
  | Readonly<{ kind: "throttled"; retryAfterSeconds: number }>;

export type Refused = Readonly<{ kind: "refused"; refusal: RehearsalRefusal }>;

/** How many times a fresh code is tried when it clashes with another event's (32^8 codes: practically never). */
const CODE_TRIES = 5;
const UNIQUE_VIOLATION = "23505";

const organizerSeat = (actor: OrganizerContext): RequestContext => ({
  organizerId: actor.organizerId,
  staffUserId: actor.staffUserId,
});

/** Runs a definer call as the team member; our refusals come back as values, anything else is rethrown. */
async function asTeam<T>(
  pool: Pool,
  actor: OrganizerContext,
  work: (client: PoolClient) => Promise<T>,
): Promise<T | Refused> {
  try {
    return await withConnection(pool, (client) =>
      withRequestContext(client, organizerSeat(actor), () => work(client)),
    );
  } catch (error) {
    const refusal = rehearsalRefusalOf(error);
    if (refusal === undefined) {
      throw error;
    }
    return { kind: "refused", refusal };
  }
}

const isClash = (error: unknown): boolean =>
  (error as { code?: unknown } | null)?.code === UNIQUE_VIOLATION;

/** Calls a definer that takes a new code, trying another when the code is taken by another event. */
async function withFreshCode<T>(
  pool: Pool,
  actor: OrganizerContext,
  work: (client: PoolClient, code: string) => Promise<T>,
  makeCode: () => string,
): Promise<T | Refused> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await asTeam(pool, actor, (client) => work(client, makeCode()));
    } catch (error) {
      if (!isClash(error) || attempt >= CODE_TRIES) {
        throw error;
      }
    }
  }
}

async function readCard(client: PoolClient, eventId: string): Promise<CardRow | undefined> {
  const { rows } = await client.query<CardRow>(
    `SELECT code, status_now, accounts, completions, points, reservations, flags, first_play_at, erased_at,
            erase_counts, live_wiped_at
     FROM rehearsal_card($1)`,
    [eventId],
  );
  return rows[0];
}

type EventRow = Readonly<{
  id: string;
  name_ar: string | null;
  name_en: string | null;
  venue_ar: string | null;
  venue_en: string | null;
  kind: string;
  timezone: string;
  starts_at: Date | null;
  ends_at: Date | null;
  status_now: "draft" | "scheduled";
}>;

type JoinRow = Readonly<{
  outcome: "joined" | "already" | "already_player" | "not_allowed" | "full" | "closed";
  enrollment_id: string | null;
  event_id: string | null;
}>;

/** The join budget of wrong codes (T-111): per address and per player, shared with join codes. */
const budgetsFor = (deps: JoinDeps, playerId: string, address: string) => [
  addressBudget(deps, address),
  { key: deps.keys.playerKey(playerId), max: JOIN_CODE_MISSES.perPlayer },
];

const asPlayer = <T>(pool: Pool, playerId: string, work: (client: PoolClient) => Promise<T>) =>
  withConnection(pool, (client) => withRequestContext(client, { playerId }, () => work(client)));

/**
 * Rehearsal mode (T-211, migration 0032): the team's card, code and erase; the player's card and join. Every write is
 * a definer; the code is made here and checked by the database.
 */
export function createRehearsal(deps: JoinDeps, makeCode: () => string = newRehearsalCode) {
  return {
    /** The card; a rehearsal not opened yet is opened with a new code while the event is before go-live. */
    card: async (actor: OrganizerContext, eventId: string): Promise<RehearsalCard | Refused> => {
      const read = await asTeam(deps.pool, actor, (client) => readCard(client, eventId));
      // Stryker disable next-line ConditionalExpression: unreachable: rehearsal_card answers one row or raises AN404
      if (read === undefined) {
        return { kind: "refused", refusal: "not_found" };
      }
      if ("kind" in read) {
        return read;
      }
      if (read.code !== null || !isOpen(read)) {
        return cardOf(read);
      }
      const opened = await withFreshCode(
        deps.pool,
        actor,
        async (client, code) => {
          await client.query("SELECT open_rehearsal($1, $2)", [eventId, code]);
          return readCard(client, eventId);
        },
        makeCode,
      );
      // Stryker disable next-line ConditionalExpression: unreachable: the card was just read under the same rules
      if (opened === undefined) {
        return { kind: "refused", refusal: "not_found" };
      }
      return "kind" in opened ? opened : cardOf(opened);
    },

    rotate: (actor: OrganizerContext, eventId: string, caller: Caller) =>
      withFreshCode(
        deps.pool,
        actor,
        async (client, code) => {
          const { rows } = await client.query<{ code: string }>(
            "SELECT rotate_rehearsal_code($1, $2, $3) AS code",
            [eventId, code, caller.requestId ?? null],
          );
          return { kind: "rotated" as const, code: rows[0]?.code ?? code };
        },
        makeCode,
      ),

    erase: (actor: OrganizerContext, eventId: string, caller: Caller) =>
      asTeam(deps.pool, actor, async (client) => {
        const { rows } = await client.query<{ counts: Record<string, unknown> }>(
          "SELECT erase_rehearsal($1, $2) AS counts",
          [eventId, caller.requestId ?? null],
        );
        return { kind: "erased" as const, counts: countsOf(rows[0]?.counts ?? {}) };
      }),

    /** The event a code opens, for the signed-in player's card; wrong codes count against the join budget. */
    eventByCode: async (
      playerId: string,
      address: string,
      code: string,
    ): Promise<
      RehearsalEvent | null | Readonly<{ kind: "throttled"; retryAfterSeconds: number }>
    > =>
      withMissBudget(deps, budgetsFor(deps, playerId, address), () =>
        asPlayer(deps.pool, playerId, async (client) => {
          const { rows } = await client.query<EventRow>(
            `SELECT id, name_ar, name_en, venue_ar, venue_en, kind, timezone, starts_at, ends_at, status_now
               FROM rehearsal_event($1)`,
            [code],
          );
          const row = rows[0];
          return row === undefined
            ? null
            : {
                id: row.id,
                name: { ar: row.name_ar, en: row.name_en },
                venue: { ar: row.venue_ar, en: row.venue_en },
                kind: row.kind,
                timezone: row.timezone,
                startsAt: row.starts_at,
                endsAt: row.ends_at,
                statusNow: row.status_now,
              };
        }),
      ),

    /** Joins as a rehearsal account; a code that opens nothing counts against the join budget like a wrong join code. */
    join: async (
      playerId: string,
      address: string,
      code: string,
      cardVersion: string,
    ): Promise<RehearsalJoin> => {
      const answer = await withMissBudget(deps, budgetsFor(deps, playerId, address), () =>
        asPlayer(deps.pool, playerId, async (client) => {
          const { rows } = await client.query<JoinRow>(
            "SELECT outcome, enrollment_id, event_id FROM join_rehearsal($1, $2)",
            [code, cardVersion],
          );
          const row = rows[0];
          return row === undefined || row.outcome === "closed" ? null : row;
        }),
      );
      if (answer === null) {
        return { kind: "closed" };
      }
      if ("kind" in answer) {
        return answer;
      }
      if (answer.outcome === "joined" || answer.outcome === "already") {
        // Stryker disable next-line StringLiteral: unreachable fallbacks: join_rehearsal names both ids when joined
        return {
          kind: answer.outcome,
          enrollmentId: answer.enrollment_id ?? "",
          eventId: answer.event_id ?? "",
        };
      }
      return { kind: answer.outcome };
    },
  };
}

export type Rehearsal = ReturnType<typeof createRehearsal>;

/**
 * The tick's step (ADR-160): every event whose rehearsal is due for its go-live wipe, one event per transaction, so a
 * failure in one leaves the others. Returns how many were wiped now (another writer may have wiped one first).
 */
export async function wipeDueRehearsals(pool: Pool): Promise<number> {
  const due = await withConnection(pool, (client) =>
    withRequestContext(client, {}, async () => {
      const { rows } = await client.query<{ event_id: string }>(
        "SELECT due_rehearsal_wipes AS event_id FROM due_rehearsal_wipes()",
      );
      return rows.map((row) => row.event_id);
    }),
  );
  let wiped = 0;
  for (const eventId of due) {
    const done = await withConnection(pool, (client) =>
      withRequestContext(client, {}, async () => {
        const { rows } = await client.query<{ wiped: boolean }>(
          "SELECT ensure_rehearsal_wiped($1) AS wiped",
          [eventId],
        );
        return rows[0]?.wiped === true;
      }),
    );
    wiped += done ? 1 : 0;
  }
  return wiped;
}

export type { RehearsalCounts };
