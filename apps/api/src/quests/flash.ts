import type { Pool } from "pg";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import type { OrganizerContext } from "#src/organizers/store";

export type FlashDeps = Readonly<{ pool: Pool }>;

/** A flash quest launches for 1 to 1,440 minutes (FR-251, ADR-231). */
export const FLASH_MINUTES = { min: 1, max: 1440 } as const;

/** A flash quest's window after Launch or End now; `replayed` when the call changed nothing. */
export type FlashWindow = Readonly<{ opensAt: string; closesAt: string; replayed: boolean }>;

/** Why Launch or End now was refused (migration 0055); each maps to one HTTP answer in the routes. */
export type FlashRefusal = Readonly<{
  kind:
    | "not_found"
    | "not_flash"
    | "event_not_live"
    | "feature_off"
    | "already_launched"
    | "scheduled"
    | "community_locked"
    | "too_late"
    | "not_started";
}>;

export type FlashDone = Readonly<{ kind: "done"; value: FlashWindow }> | FlashRefusal;

const FL409: ReadonlySet<string> = new Set([
  "already_launched",
  "scheduled",
  "community_locked",
  "too_late",
  "not_started",
]);

/** The SQLSTATEs of launch_flash and end_flash as refusals; undefined for anything else. */
export function flashRefusalOf(
  pg: Readonly<{ code?: string; detail?: string }>,
): FlashRefusal | undefined {
  switch (pg.code) {
    case "AN404":
      return { kind: "not_found" };
    case "FN422":
      return { kind: "not_flash" };
    case "FE409":
      return { kind: "event_not_live" };
    case "FF403":
      return { kind: "feature_off" };
    case "FL409":
      return FL409.has(pg.detail ?? "") ? ({ kind: pg.detail } as FlashRefusal) : undefined;
    default:
      return undefined;
  }
}

type WindowRow = { opens_at: Date; closes_at: Date; replayed: boolean };

type Target = Readonly<{ eventId: string; questId: string; requestId: string }>;

/** Runs `launch_flash` or `end_flash` as the caller, inside their organizer and event limit. */
async function callFlash(
  deps: FlashDeps,
  context: OrganizerContext,
  sql: string,
  values: readonly unknown[],
): Promise<FlashDone> {
  const seat = { organizerId: context.organizerId, staffUserId: context.staffUserId };
  try {
    const row = await withConnection(deps.pool, (client) =>
      withRequestContext(client, seat, async () => {
        const { rows } = await client.query<WindowRow>(sql, [...values]);
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
    const refusal = flashRefusalOf(error as { code?: string; detail?: string });
    if (refusal === undefined) {
      throw error;
    }
    return refusal;
  }
}

/**
 * Launches a draft flash quest now for its minutes, never past the event's end (FR-251): in a live event or during a
 * rehearsal; once (a second launch while open answers the first). Audited by the database.
 */
export function launchFlash(
  deps: FlashDeps,
  context: OrganizerContext,
  target: Target & Readonly<{ minutes: number }>,
): Promise<FlashDone> {
  return callFlash(deps, context, "SELECT * FROM launch_flash($1, $2, $3, $4)", [
    target.eventId,
    target.questId,
    target.minutes,
    target.requestId,
  ]);
}

/** Ends a running flash quest now; an ended one stays as it is. Audited by the database. */
export function endFlash(
  deps: FlashDeps,
  context: OrganizerContext,
  target: Target,
): Promise<FlashDone> {
  return callFlash(deps, context, "SELECT * FROM end_flash($1, $2, $3)", [
    target.eventId,
    target.questId,
    target.requestId,
  ]);
}
