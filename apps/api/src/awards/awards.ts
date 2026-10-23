import type { Pool, PoolClient } from "pg";
import type { AuthKeys } from "#src/auth/keys";
import { AWARD_FIND_LIMIT } from "#src/auth/limits";
import { BUCKETS, countRecent, record } from "#src/auth/throttle";
import { withConnection } from "#src/db/connection";
import { withRequestContext, type RequestContext } from "#src/db/context";
import type { OrganizerContext } from "#src/organizers/store";
import type { Bilingual } from "#src/quests/store";
import type { BulkLines } from "#src/awards/lines";

export type PoolDeps = Readonly<{ pool: Pool }>;
/** The operator's find also counts toward a per-operator limit, keyed like the other player throttles. */
export type AwardsDeps = PoolDeps & Readonly<{ keys: AuthKeys }>;

/** Why an award, a removal or a bulk award was refused; each maps to one HTTP answer in the routes. */
export type AwardRefusal =
  | Readonly<{ kind: "not_found" }>
  | Readonly<{ kind: "not_operator" }>
  | Readonly<{ kind: "ability_off" }>
  | Readonly<{ kind: "outside_station" }>
  | Readonly<{ kind: "self_award" }>
  | Readonly<{ kind: "enrollment_inactive"; reason: string }>
  | Readonly<{ kind: "quest_not_open"; reason: string }>
  | Readonly<{ kind: "already_completed" }>
  | Readonly<{ kind: "operator_not_playing" }>
  | Readonly<{ kind: "over_cap"; cap: "each" | "day"; limit: number; left: number }>
  | Readonly<{ kind: "reason_required" }>
  | Readonly<{ kind: "invalid_amount" }>
  | Readonly<{ kind: "key_reused" }>
  | Readonly<{ kind: "already_removed" }>
  | Readonly<{ kind: "open_reservation" }>
  | Readonly<{ kind: "not_removable" }>
  | Readonly<{ kind: "removal_closed" }>
  | Readonly<{ kind: "results_final" }>
  | Readonly<{ kind: "too_many_lines" }>;

export type AwardDone<T> = Readonly<{ kind: "done"; value: T }> | AwardRefusal;

const overCap = (detail: string, hint: string): AwardRefusal => {
  const [limit, left] = hint.split(",").map(Number);
  return {
    kind: "over_cap",
    cap: detail === "day" ? "day" : "each",
    limit: limit ?? 0,
    left: left ?? 0,
  };
};

/** The SQLSTATEs of migration 0030's definers and the completion engine under them. */
const REFUSALS: Readonly<Record<string, (detail: string, hint: string) => AwardRefusal>> = {
  OP403: () => ({ kind: "not_operator" }),
  OA403: () => ({ kind: "ability_off" }),
  OS403: () => ({ kind: "outside_station" }),
  AY409: () => ({ kind: "self_award" }),
  QC404: () => ({ kind: "not_found" }),
  AQ404: () => ({ kind: "not_found" }),
  AN404: () => ({ kind: "not_found" }),
  AE404: () => ({ kind: "not_found" }),
  QC403: (detail) => ({ kind: "enrollment_inactive", reason: detail }),
  QN403: (detail) => ({ kind: "quest_not_open", reason: detail }),
  QD409: () => ({ kind: "already_completed" }),
  QP403: () => ({ kind: "operator_not_playing" }),
  AC409: overCap,
  AR400: () => ({ kind: "reason_required" }),
  AP400: () => ({ kind: "invalid_amount" }),
  AK422: () => ({ kind: "key_reused" }),
  QK422: () => ({ kind: "key_reused" }),
  AD409: () => ({ kind: "already_removed" }),
  AO409: () => ({ kind: "open_reservation" }),
  AT422: () => ({ kind: "not_removable" }),
  AS409: () => ({ kind: "removal_closed" }),
  // The results are confirmed (migration 0034): nothing comes off any more.
  RF409: () => ({ kind: "results_final" }),
  AB400: () => ({ kind: "too_many_lines" }),
};

/** Runs one call in `context`; a refusal the database raises becomes its result, anything else is thrown. */
async function run<T>(
  deps: PoolDeps,
  context: RequestContext,
  work: (client: PoolClient) => Promise<T>,
): Promise<AwardDone<T>> {
  try {
    const value = await withConnection(deps.pool, (client) =>
      withRequestContext(client, context, () => work(client)),
    );
    return { kind: "done", value };
  } catch (error) {
    const pg = error as { code?: string; detail?: string; hint?: string };
    const refusal = pg.code === undefined ? undefined : REFUSALS[pg.code];
    if (refusal === undefined) {
      throw error;
    }
    return refusal(pg.detail ?? "", pg.hint ?? "");
  }
}

const staffSeat = (context: OrganizerContext): RequestContext => ({
  organizerId: context.organizerId,
  staffUserId: context.staffUserId,
});
const text = (ar: unknown, en: unknown): Bilingual => ({
  ar: typeof ar === "string" ? ar : null,
  en: typeof en === "string" ? en : null,
});
const nullable = (value: unknown): string | null => (typeof value === "string" ? value : null);

/** What to award: a quest (its points) or an amount, never both (the routes' schema makes sure). */
export type AwardWhat = Readonly<
  { questId: string; points: null } | { questId: null; points: number }
>;

export type AwardRequest = Readonly<{
  eventId: string;
  enrollmentId: string;
  what: AwardWhat;
  reason: string;
  idempotencyKey: string;
}>;

export type Awarded = Readonly<{ entryId: string; points: number; replayed: boolean }>;

const awardedOf = (rows: readonly Record<string, unknown>[]): Awarded => {
  const row = rows[0] ?? {};
  return {
    entryId: String(row["entry_id"]),
    points: Number(row["points"]),
    replayed: row["replayed"] === true,
  };
};

export type FoundPlayer = Readonly<{
  enrollmentId: string;
  username: string;
  avatar: string;
  active: boolean;
}>;

/**
 * FR-308: an operator finds one member of the event by exact username or phone. Every find counts toward the
 * operator's limit before it runs (it can name a phone number's owner), refused or not.
 */
export async function findPlayer(
  deps: AwardsDeps,
  operatorId: string,
  request: Readonly<{ eventId: string; username: string | null; phone: string | null }>,
): Promise<
  AwardDone<FoundPlayer | null> | Readonly<{ kind: "throttled"; retryAfterSeconds: number }>
> {
  const key = deps.keys.playerKey(operatorId);
  const window = await withConnection(deps.pool, (client) =>
    withRequestContext(client, {}, async () => {
      const recent = await countRecent(
        client,
        BUCKETS.awardFind,
        key,
        AWARD_FIND_LIMIT.windowSeconds,
      );
      if (recent.count < AWARD_FIND_LIMIT.max) {
        await record(client, BUCKETS.awardFind, key);
      }
      return recent;
    }),
  );
  if (window.count >= AWARD_FIND_LIMIT.max) {
    return { kind: "throttled", retryAfterSeconds: window.retryAfterSeconds };
  }
  return run(deps, { playerId: operatorId }, async (client) => {
    const { rows } = await client.query("SELECT * FROM operator_find_player($1, $2, $3)", [
      request.eventId,
      request.username,
      request.phone,
    ]);
    const row = rows[0];
    return row === undefined
      ? null
      : {
          enrollmentId: String(row["enrollment_id"]),
          username: String(row["username"]),
          avatar: String(row["avatar"]),
          active: row["active"] === true,
        };
  });
}

export type AwardForm = Readonly<{
  capEach: number;
  capDay: number;
  leftToday: number;
  live: boolean;
  quests: readonly Readonly<{ id: string; title: Bilingual; points: number }>[];
}>;

/** What the operator's award form shows (FR-310): the caps, what is left today, the quests they may award. */
export function awardForm(
  deps: PoolDeps,
  operatorId: string,
  eventId: string,
): Promise<AwardDone<AwardForm>> {
  return run(deps, { playerId: operatorId }, async (client) => {
    const state =
      (await client.query("SELECT * FROM operator_award_state($1)", [eventId])).rows[0] ?? {};
    const quests = (await client.query("SELECT * FROM operator_award_quests($1)", [eventId])).rows;
    return {
      capEach: Number(state["cap_each"]),
      capDay: Number(state["cap_day"]),
      leftToday: Number(state["left_today"]),
      live: state["live"] === true,
      quests: quests.map((row) => ({
        id: String(row["quest_id"]),
        title: text(row["title_ar"], row["title_en"]),
        points: Number(row["points"]),
      })),
    };
  });
}

/** FR-308 to FR-310: the operator's award, inside the caps. */
export function operatorAward(
  deps: PoolDeps,
  operatorId: string,
  request: AwardRequest,
): Promise<AwardDone<Awarded>> {
  return run(deps, { playerId: operatorId }, async (client) =>
    awardedOf(
      (
        await client.query("SELECT * FROM operator_award($1, $2, $3, $4, $5, $6)", [
          request.eventId,
          request.enrollmentId,
          request.what.questId,
          request.what.points,
          request.reason,
          request.idempotencyKey,
        ])
      ).rows,
    ),
  );
}

/** FR-1027: an owner's or editor's award from the dashboard; editors inside the caps. */
export function staffAward(
  deps: PoolDeps,
  context: OrganizerContext,
  request: AwardRequest & Readonly<{ requestId: string }>,
): Promise<AwardDone<Awarded>> {
  return run(deps, staffSeat(context), async (client) =>
    awardedOf(
      (
        await client.query("SELECT * FROM staff_award($1, $2, $3, $4, $5, $6, $7)", [
          request.eventId,
          request.enrollmentId,
          request.what.questId,
          request.what.points,
          request.reason,
          request.idempotencyKey,
          request.requestId,
        ])
      ).rows,
    ),
  );
}

/** What a removal did to the credit's quest item (T-304d). */
export type RemovedItem = "cancelled" | "handed_over" | null;

export const removedItemOf = (value: unknown): RemovedItem =>
  value === "cancelled" || value === "handed_over" ? value : null;

export type Removed = Readonly<{
  entryId: string;
  scoreDelta: number;
  balanceDelta: number;
  replayed: boolean;
  /** The credit's quest item (T-304d): cancelled by this removal, handed over already (it stays), or null. */
  item: RemovedItem;
}>;

/** FR-320, FR-1601: removes a credit entry; neither the score nor the balance goes below zero. */
export function removeAward(
  deps: PoolDeps,
  context: OrganizerContext,
  request: Readonly<{
    eventId: string;
    entryId: string;
    reason: string;
    idempotencyKey: string;
    requestId: string;
  }>,
): Promise<AwardDone<Removed>> {
  return run(deps, staffSeat(context), async (client) => {
    const { rows } = await client.query("SELECT * FROM remove_award($1, $2, $3, $4, $5)", [
      request.eventId,
      request.entryId,
      request.reason,
      request.idempotencyKey,
      request.requestId,
    ]);
    const row = rows[0] ?? {};
    return {
      entryId: String(row["entry_id"]),
      scoreDelta: Number(row["score_delta"]),
      balanceDelta: Number(row["balance_delta"]),
      replayed: row["replayed"] === true,
      item: removedItemOf(row["item"]),
    };
  });
}

type Who = Readonly<{ operator: string | null; staff: string | null }>;

export type LedgerLine = Readonly<{
  id: string;
  at: Date;
  kind: string;
  scoreDelta: number;
  balanceDelta: number;
  questId: string | null;
  title: Bilingual;
  reason: string | null;
  by: Who;
  reverses: string | null;
  removable: boolean;
  removed: boolean;
}>;

/** One member's points record for the dashboard, newest first (owners and editors). */
export function memberLedger(
  deps: PoolDeps,
  context: OrganizerContext,
  request: Readonly<{
    eventId: string;
    enrollmentId: string;
    beforeId: string | null;
    limit: number;
  }>,
): Promise<AwardDone<LedgerLine[]>> {
  return run(deps, staffSeat(context), async (client) => {
    const { rows } = await client.query("SELECT * FROM member_ledger($1, $2, $3, $4)", [
      request.eventId,
      request.enrollmentId,
      request.beforeId,
      request.limit,
    ]);
    return rows.map((row) => ({
      id: String(row["id"]),
      at: row["at"] as Date,
      kind: String(row["kind"]),
      scoreDelta: Number(row["score_delta"]),
      balanceDelta: Number(row["balance_delta"]),
      questId: nullable(row["quest_id"]),
      title: text(row["title_ar"], row["title_en"]),
      reason: nullable(row["reason"]),
      by: { operator: nullable(row["by_operator"]), staff: nullable(row["by_staff"]) },
      reverses: row["reverses"] === null ? null : String(row["reverses"]),
      removable: row["removable"] === true,
      removed: row["removed"] === true,
    }));
  });
}

export type ReportLine = Readonly<{
  id: string;
  at: Date;
  kind: "quest" | "award" | "removal";
  /** The full amount: for a removal, the amount of the entry it reverses (FR-1601). */
  points: number;
  scoreDelta: number;
  balanceDelta: number;
  reverses: string | null;
  /** `username` is null for a deleted account (T-217). */
  player: Readonly<{ enrollmentId: string; username: string | null }>;
  quest: Readonly<{ id: string; title: Bilingual }> | null;
  reason: string | null;
  bulkId: string | null;
  by: Who;
  removed: boolean;
}>;

export type Report = Readonly<{
  caps: Readonly<{ each: number; day: number }>;
  lines: ReportLine[];
}>;

/** FR-311: every manual entry of the event, newest first, and the caps in force. */
export function report(
  deps: PoolDeps,
  context: OrganizerContext,
  request: Readonly<{ eventId: string; beforeId: string | null; limit: number }>,
): Promise<AwardDone<Report>> {
  return run(deps, staffSeat(context), async (client) => {
    const { rows } = await client.query("SELECT * FROM manual_awards($1, $2, $3)", [
      request.eventId,
      request.beforeId,
      request.limit,
    ]);
    const caps = (
      await client.query("SELECT award_cap_each, award_cap_day FROM event WHERE id = $1", [
        request.eventId,
      ])
    ).rows[0];
    return {
      caps: { each: Number(caps?.["award_cap_each"]), day: Number(caps?.["award_cap_day"]) },
      lines: rows.map((row) => ({
        id: String(row["id"]),
        at: row["at"] as Date,
        kind: row["kind"] as ReportLine["kind"],
        points: Number(row["points"]),
        scoreDelta: Number(row["score_delta"]),
        balanceDelta: Number(row["balance_delta"]),
        reverses: row["reverses"] === null ? null : String(row["reverses"]),
        player: {
          enrollmentId: String(row["enrollment_id"]),
          username: row["username"] === null ? null : String(row["username"]),
        },
        quest:
          row["quest_id"] === null
            ? null
            : { id: String(row["quest_id"]), title: text(row["title_ar"], row["title_en"]) },
        reason: nullable(row["reason"]),
        bulkId: nullable(row["bulk_id"]),
        by: { operator: nullable(row["by_operator"]), staff: nullable(row["by_staff"]) },
        removed: row["removed"] === true,
      })),
    };
  });
}

export type BulkPreview = Readonly<{
  matched: readonly Readonly<{ enrollmentId: string; username: string }>[];
  /** Lines naming a member who cannot receive points now (banned, left, pending, an operator who may not play). */
  inactive: readonly string[];
  notFound: readonly string[];
}>;

/** FR-1712: matches a list to the event's members before the owner or editor confirms. */
export function previewList(
  deps: PoolDeps,
  context: OrganizerContext,
  request: Readonly<{ eventId: string; lines: BulkLines }>,
): Promise<AwardDone<BulkPreview>> {
  return run(deps, staffSeat(context), async (client) => {
    const { rows } = await client.query("SELECT * FROM resolve_bulk_targets($1, $2, $3)", [
      request.eventId,
      request.lines.usernames,
      request.lines.phones,
    ]);
    const matched = new Map<string, string>();
    const inactive: string[] = [];
    const notFound: string[] = [];
    for (const row of rows) {
      const line = String(row["line"]);
      if (row["enrollment_id"] === null) {
        notFound.push(line);
      } else if (row["active"] === true) {
        matched.set(String(row["enrollment_id"]), String(row["username"]));
      } else {
        inactive.push(line);
      }
    }
    return {
      matched: [...matched].map(([enrollmentId, username]) => ({ enrollmentId, username })),
      inactive,
      notFound,
    };
  });
}

/** FR-1712: how many members a quest target reaches (its completers whose points were not removed). */
export function previewQuest(
  deps: PoolDeps,
  context: OrganizerContext,
  request: Readonly<{ eventId: string; questId: string }>,
): Promise<AwardDone<number>> {
  return run(deps, staffSeat(context), async (client) => {
    const { rows } = await client.query("SELECT quest_bulk_count($1, $2) AS count", [
      request.eventId,
      request.questId,
    ]);
    return Number(rows[0]?.["count"]);
  });
}

export type BulkTarget =
  | Readonly<{ enrollmentIds: readonly string[]; questId: null }>
  | Readonly<{ enrollmentIds: null; questId: string }>;

export type BulkDone = Readonly<{
  bulkId: string;
  awarded: number;
  skipped: number;
  replayed: boolean;
}>;

/** FR-1712: the same points to many members in one step, outside the daily caps. */
export function bulkAward(
  deps: PoolDeps,
  context: OrganizerContext,
  request: Readonly<{
    eventId: string;
    target: BulkTarget;
    points: number;
    reason: string;
    idempotencyKey: string;
    requestId: string;
  }>,
): Promise<AwardDone<BulkDone>> {
  return run(deps, staffSeat(context), async (client) => {
    const { rows } = await client.query("SELECT * FROM bulk_award($1, $2, $3, $4, $5, $6, $7)", [
      request.eventId,
      request.target.enrollmentIds,
      request.target.questId,
      request.points,
      request.reason,
      request.idempotencyKey,
      request.requestId,
    ]);
    const row = rows[0] ?? {};
    return {
      bulkId: String(row["bulk_id"]),
      awarded: Number(row["awarded"]),
      skipped: Number(row["skipped"]),
      replayed: row["replayed"] === true,
    };
  });
}

/** FR-310: the owner sets the event's caps. */
export function setCaps(
  deps: PoolDeps,
  context: OrganizerContext,
  request: Readonly<{ eventId: string; each: number; day: number; requestId: string }>,
): Promise<AwardDone<"changed" | "unchanged" | "not_owner">> {
  return run(deps, staffSeat(context), async (client) => {
    const { rows } = await client.query<{ outcome: "changed" | "unchanged" | "not_owner" }>(
      "SELECT set_award_caps($1, $2, $3, $4) AS outcome",
      [request.eventId, request.each, request.day, request.requestId],
    );
    return rows[0]?.outcome ?? "not_owner";
  });
}
