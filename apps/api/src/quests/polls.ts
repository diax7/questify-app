import type { Pool } from "pg";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import type { OrganizerContext } from "#src/organizers/store";

export type PollDeps = Readonly<{ pool: Pool }>;

/** A live poll's window after Send or Close; `replayed` when the call changed nothing (a second send or close). */
export type PollWindow = Readonly<{ opensAt: string; closesAt: string; replayed: boolean }>;

/** Why Send or Close was refused (migration 0052); each maps to one HTTP answer in the routes. */
export type PollRefusal = Readonly<{
  kind: "not_found" | "not_live_poll" | "already_sent" | "not_sent" | "event_not_live";
}>;

export type PollDone = Readonly<{ kind: "done"; value: PollWindow }> | PollRefusal;

const REFUSALS: Readonly<Record<string, (detail: string) => PollRefusal | undefined>> = {
  AN404: () => ({ kind: "not_found" }),
  PN422: () => ({ kind: "not_live_poll" }),
  PE409: () => ({ kind: "event_not_live" }),
  PS409: (detail) =>
    detail === "already_sent" || detail === "not_sent" ? { kind: detail } : undefined,
};

type WindowRow = { opens_at: Date; closes_at: Date; replayed: boolean };

/** Runs `send_poll` or `close_poll` as the caller, inside their organizer and event limit. */
async function callPoll(
  deps: PollDeps,
  context: OrganizerContext,
  call: "send_poll" | "close_poll",
  target: Readonly<{ eventId: string; questId: string; requestId: string }>,
): Promise<PollDone> {
  const seat = { organizerId: context.organizerId, staffUserId: context.staffUserId };
  try {
    const row = await withConnection(deps.pool, (client) =>
      withRequestContext(client, seat, async () => {
        const { rows } = await client.query<WindowRow>(`SELECT * FROM ${call}($1, $2, $3)`, [
          target.eventId,
          target.questId,
          target.requestId,
        ]);
        return rows[0] as WindowRow;
      }),
    );
    return {
      kind: "done",
      value: {
        opensAt: row.opens_at.toISOString(),
        closesAt: row.closes_at.toISOString(),
        replayed: row.replayed,
      },
    };
  } catch (error) {
    const pg = error as { code?: string; detail?: string };
    const refusal = pg.code === undefined ? undefined : REFUSALS[pg.code]?.(pg.detail ?? "");
    if (refusal === undefined) {
      throw error;
    }
    return refusal;
  }
}

/**
 * Sends a draft live poll (FR-239, ADR-220): open now for its minutes, never past the event's end; in a live event or
 * during a rehearsal. Audited by the database.
 */
export function sendPoll(
  deps: PollDeps,
  context: OrganizerContext,
  target: Readonly<{ eventId: string; questId: string; requestId: string }>,
): Promise<PollDone> {
  return callPoll(deps, context, "send_poll", target);
}

/** Closes a sent live poll now (FR-239); a closed one stays as it is. Audited by the database. */
export function closePoll(
  deps: PollDeps,
  context: OrganizerContext,
  target: Readonly<{ eventId: string; questId: string; requestId: string }>,
): Promise<PollDone> {
  return callPoll(deps, context, "close_poll", target);
}
