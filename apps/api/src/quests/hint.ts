import type { Pool, QueryResultRow } from "pg";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import type { OrganizerContext } from "#src/organizers/store";

export type HintDeps = Readonly<{ pool: Pool }>;

/** How many members a hint would tell now, and whether the last hint is still being delivered (migration 0080). */
export type HintPreview = Readonly<{ members: number; pending: boolean }>;

/** A press that was accepted; `replayed` when its Idempotency-Key had already sent the hint. */
export type HintSent = Readonly<{ replayed: boolean }>;

/** Why the hint's doors refused (migration 0080); each maps to one HTTP answer in the routes. */
export type HintRefusal = Readonly<{
  kind:
    | "not_found"
    | "not_hidden"
    | "event_not_live"
    | "in_progress"
    /** The press would tell no one: every member who may be told already was, or there are none. */
    | "nobody"
    /** The push store could not take the notice (its kind row is missing): nothing was sent. */
    | "not_written";
}>;

export type HintDone<T> = Readonly<{ kind: "done"; value: T }> | HintRefusal;

const REFUSALS: Readonly<Record<string, HintRefusal>> = {
  AN404: { kind: "not_found" },
  QH422: { kind: "not_hidden" },
  PE409: { kind: "event_not_live" },
  PH409: { kind: "in_progress" },
  PT409: { kind: "nobody" },
};

type Target = Readonly<{ eventId: string; categoryId: string }>;

/** Runs one of the hint's doors as the caller, inside their organizer and event limit. */
async function callHint<Row extends QueryResultRow, T>(
  deps: HintDeps,
  context: OrganizerContext,
  call: Readonly<{ sql: string; values: readonly unknown[]; valueOf: (row: Row) => HintDone<T> }>,
): Promise<HintDone<T>> {
  const seat = { organizerId: context.organizerId, staffUserId: context.staffUserId };
  try {
    const row = await withConnection(deps.pool, (client) =>
      withRequestContext(client, seat, async () => {
        const { rows } = await client.query<Row>(call.sql, [...call.values]);
        return rows[0] as Row;
      }),
    );
    return call.valueOf(row);
  } catch (error) {
    const refusal = REFUSALS[(error as { code?: string }).code ?? ""];
    if (refusal === undefined) {
      throw error;
    }
    return refusal;
  }
}

/**
 * The count behind the confirmation: the members a hint on this hidden category would tell now (active, real, in the
 * category's audience, not told by an earlier hint since they joined) and whether the last hint is still on its way.
 * A read; the event must be live or in an open rehearsal.
 */
export function previewHint(
  deps: HintDeps,
  context: OrganizerContext,
  target: Target,
): Promise<HintDone<HintPreview>> {
  return callHint(deps, context, {
    sql: "SELECT members, pending FROM category_hint_preview($1, $2)",
    values: [target.eventId, target.categoryId],
    valueOf: (row: HintPreview) => ({
      kind: "done",
      value: { members: row.members, pending: row.pending },
    }),
  });
}

/**
 * Sends the hint of a hidden category (FR-238, T-501g): one push-store notice per `press` (the request's
 * Idempotency-Key), from which the fan-out reveals the category to each member it tells. Audited by the database.
 */
export function sendHint(
  deps: HintDeps,
  context: OrganizerContext,
  target: Target & Readonly<{ press: string; requestId: string }>,
): Promise<HintDone<HintSent>> {
  return callHint(deps, context, {
    sql: "SELECT sent, replayed FROM send_category_hint($1, $2, $3, $4)",
    values: [target.eventId, target.categoryId, target.press, target.requestId],
    valueOf: (row: { sent: boolean; replayed: boolean }) =>
      row.sent ? { kind: "done", value: { replayed: row.replayed } } : { kind: "not_written" },
  });
}
