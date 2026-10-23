import type { Pool, PoolClient } from "pg";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import type { OrganizerContext } from "#src/organizers/store";

export type FlagsDeps = Readonly<{ pool: Pool }>;

export type FlagKind = "shared_device" | "burst";
export type FlagStatus = "open" | "cleared" | "confirmed";
export type Resolution = "cleared" | "points_removed" | "banned";

/** Why a team action on flags was refused; each maps to one HTTP answer in the routes. */
export type FlagRefusal =
  | Readonly<{ kind: "not_found" }>
  | Readonly<{ kind: "resolved" }>
  | Readonly<{ kind: "no_removal" }>
  | Readonly<{ kind: "invalid" }>;

export type FlagDone<T> = Readonly<{ kind: "done"; value: T }> | FlagRefusal;

/** The SQLSTATEs of migration 0031's team definers. */
const REFUSALS: Readonly<Record<string, (detail: string) => FlagRefusal>> = {
  AN404: () => ({ kind: "not_found" }),
  FN404: () => ({ kind: "not_found" }),
  FN409: (detail) => ({ kind: detail === "no_removal" ? "no_removal" : "resolved" }),
  FV400: () => ({ kind: "invalid" }),
};

/** Runs one call in the team member's seat; a refusal the database raises becomes its result. */
async function asTeam<T>(
  deps: FlagsDeps,
  context: OrganizerContext,
  work: (client: PoolClient) => Promise<T>,
): Promise<FlagDone<T>> {
  try {
    const value = await withConnection(deps.pool, (client) =>
      withRequestContext(
        client,
        { organizerId: context.organizerId, staffUserId: context.staffUserId },
        () => work(client),
      ),
    );
    return { kind: "done", value };
  } catch (error) {
    const pg = error as { code?: string; detail?: string };
    const refusal = pg.code === undefined ? undefined : REFUSALS[pg.code];
    if (refusal === undefined) {
      throw error;
    }
    return refusal(pg.detail ?? "");
  }
}

const iso = (value: unknown): string | null => (value instanceof Date ? value.toISOString() : null);
const count = (value: unknown): number | null => (typeof value === "number" ? value : null);

/** One case on the flagged-activity page (FR-335). */
export type FlagLine = Readonly<{
  id: string;
  kind: FlagKind;
  status: FlagStatus;
  resolution: Resolution | null;
  raisedAt: string | null;
  lastSeenAt: string | null;
  resolvedAt: string | null;
  player: Readonly<{ enrollmentId: string; username: string; avatar: string }>;
  /** Same phone: how many of the event's accounts were seen on it. */
  accounts: number | null;
  /** Burst: how many scans the case holds. */
  scans: number | null;
  /** The player's reservations waiting at the desk. */
  waiting: number;
}>;

function lineOf(row: Readonly<Record<string, unknown>>): FlagLine {
  return {
    id: String(row["id"]),
    kind: row["kind"] as FlagKind,
    status: row["status"] as FlagStatus,
    resolution: (row["resolution"] ?? null) as Resolution | null,
    raisedAt: iso(row["raised_at"]),
    lastSeenAt: iso(row["last_seen_at"]),
    resolvedAt: iso(row["resolved_at"]),
    player: {
      enrollmentId: String(row["enrollment_id"]),
      username: String(row["username"]),
      avatar: String(row["avatar"]),
    },
    accounts: count(row["accounts"]),
    scans: count(row["scans"]),
    waiting: count(row["waiting"]) ?? 0,
  };
}

/** The event's cases, newest first, with whether the desk holds flagged players (FR-1815). */
export function listFlags(
  deps: FlagsDeps,
  context: OrganizerContext,
  request: Readonly<{ eventId: string; open: boolean; beforeId: string | null; limit: number }>,
): Promise<FlagDone<Readonly<{ hold: boolean; flags: readonly FlagLine[] }>>> {
  return asTeam(deps, context, async (client) => {
    const { rows } = await client.query("SELECT * FROM event_flags($1, $2, $3, $4)", [
      request.eventId,
      request.open,
      request.beforeId,
      request.limit,
    ]);
    const { rows: held } = await client.query<{ flag_hold: boolean }>(
      "SELECT flag_hold FROM event WHERE id = $1",
      [request.eventId],
    );
    return { hold: held[0]?.flag_hold !== false, flags: rows.map(lineOf) };
  });
}

/** One case with its evidence, the player's waiting items, the pause and the removals since it was raised. */
export type FlagDetail = FlagLine &
  Readonly<{
    note: string | null;
    resolvedBy: string | null;
    enrollmentStatus: string;
    paused: boolean;
    hold: boolean;
    evidence: readonly unknown[];
    waitingItems: readonly unknown[];
    removals: readonly unknown[];
  }>;

const list = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);

export function flagDetail(
  deps: FlagsDeps,
  context: OrganizerContext,
  request: Readonly<{ eventId: string; flagId: string }>,
): Promise<FlagDone<FlagDetail | null>> {
  return asTeam(deps, context, async (client) => {
    const { rows } = await client.query("SELECT * FROM flag_detail($1, $2)", [
      request.eventId,
      request.flagId,
    ]);
    const row = rows[0];
    if (row === undefined) {
      return null;
    }
    const waitingItems = list(row["waiting"]);
    return {
      ...lineOf({ ...row, waiting: waitingItems.length, accounts: null, scans: null }),
      note: (row["note"] ?? null) as string | null,
      resolvedBy: (row["resolved_by"] ?? null) as string | null,
      enrollmentStatus: String(row["enrollment_status"]),
      paused: row["paused"] === true,
      hold: row["hold"] === true,
      evidence: list(row["evidence"]),
      waitingItems,
      removals: list(row["removals"]),
    };
  });
}

/** Clears a case or closes it as points removed (FR-336); owners and editors; audited by the database. */
export function resolveFlag(
  deps: FlagsDeps,
  context: OrganizerContext,
  request: Readonly<{
    eventId: string;
    flagId: string;
    resolution: "cleared" | "points_removed";
    note: string | null;
    requestId: string;
  }>,
): Promise<FlagDone<Readonly<{ status: FlagStatus; resolution: Resolution }>>> {
  return asTeam(deps, context, async (client) => {
    const { rows } = await client.query<{ status: FlagStatus; resolution: Resolution }>(
      "SELECT status, resolution FROM resolve_flag($1, $2, $3, $4, $5)",
      [request.eventId, request.flagId, request.resolution, request.note, request.requestId],
    );
    const row = rows[0];
    if (row === undefined) {
      throw new Error("resolve_flag answered no row");
    }
    return { status: row.status, resolution: row.resolution };
  });
}

export type SwitchOutcome = "changed" | "unchanged" | "not_owner" | "not_found";

/** The owner pauses or resumes one player's redemptions (FR-518, FR-1604). */
export function setRedeemPause(
  deps: FlagsDeps,
  context: OrganizerContext,
  request: Readonly<{ eventId: string; enrollmentId: string; paused: boolean; requestId: string }>,
): Promise<FlagDone<SwitchOutcome>> {
  return asTeam(deps, context, async (client) => {
    const { rows } = await client.query<{ outcome: SwitchOutcome }>(
      "SELECT set_redeem_pause($1, $2, $3, $4) AS outcome",
      [request.eventId, request.enrollmentId, request.paused, request.requestId],
    );
    return rows[0]?.outcome ?? "not_found";
  });
}

/** The owner switches the event's flag hold at the desk (FR-1815). */
export function setFlagHold(
  deps: FlagsDeps,
  context: OrganizerContext,
  request: Readonly<{ eventId: string; on: boolean; requestId: string }>,
): Promise<FlagDone<SwitchOutcome>> {
  return asTeam(deps, context, async (client) => {
    const { rows } = await client.query<{ outcome: SwitchOutcome }>(
      "SELECT set_flag_hold($1, $2, $3) AS outcome",
      [request.eventId, request.on, request.requestId],
    );
    return rows[0]?.outcome ?? "not_found";
  });
}
