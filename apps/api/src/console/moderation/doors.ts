import {
  flagsAnswerSchema,
  reportDetailSchema,
  reportQueueSchema,
  type FlagsAnswer,
  type HoldKind,
  type HoldReason,
  type ReportDetail,
  type ReportKind,
  type ReportOutcome,
  type ReportQueue,
} from "@questify/shared";
import type { Pool } from "pg";
import { invalidHold, invalidReport, notFound, notUnpublished } from "#src/auth/http-errors";
import { door, type Admin } from "#src/console/doors";
import type { HttpError } from "#src/http-error";

/** The refusals of the moderation doors (migration 0121) that `door` does not already know. */
const REFUSALS: Readonly<Record<string, () => HttpError>> = {
  HD400: invalidHold,
  HD404: notFound,
  RP422: invalidReport,
};

/** Runs a moderation door: its own refusals first, then the console's (a caller who is not an admin is 404). */
async function moderation<T>(
  pool: Pool,
  admin: Admin,
  sql: string,
  values: readonly unknown[],
): Promise<T> {
  try {
    return await door(pool, admin, async (client) => {
      const { rows } = await client.query<{ r: T }>(sql, [...values]);
      return rows[0]?.r as T;
    });
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    const refusal =
      typeof code === "string" && Object.hasOwn(REFUSALS, code) ? REFUSALS[code] : undefined;
    if (refusal === undefined) {
      throw error;
    }
    throw refusal();
  }
}

/** The open targets of Questify's queue, oldest first, optionally of one kind (`console_reports`, audited). */
export async function readQueue(
  pool: Pool,
  admin: Admin,
  kind: ReportKind | null,
  requestId: string,
): Promise<ReportQueue> {
  const raw = await moderation<unknown>(pool, admin, "SELECT console_reports($1, $2) AS r", [
    kind,
    requestId,
  ]);
  return reportQueueSchema.parse(raw);
}

/** One target's reports beside its content now (`console_report`, audited). @throws HttpError 404 when never reported. */
export async function readTarget(
  pool: Pool,
  admin: Admin,
  target: Readonly<{ kind: ReportKind; targetId: string }>,
  requestId: string,
): Promise<ReportDetail> {
  const raw = await moderation<unknown>(pool, admin, "SELECT console_report($1, $2, $3) AS r", [
    target.kind,
    target.targetId,
    requestId,
  ]);
  return reportDetailSchema.parse(raw);
}

/** Closes every open report of a target with one outcome; answers how many closed. */
export function resolveReports(
  pool: Pool,
  admin: Admin,
  input: Readonly<{ kind: ReportKind; targetId: string; outcome: ReportOutcome }>,
  requestId: string,
): Promise<number> {
  return moderation<number>(pool, admin, "SELECT admin_report_resolve($1, $2, $3, $4) AS r", [
    input.kind,
    input.targetId,
    input.outcome,
    requestId,
  ]);
}

export type HoldInput = Readonly<{ kind: HoldKind; targetId: string; note: string }>;

/**
 * Unpublishes a quest, a reward or an announcement (FR-1414): the door locks the target, closes its open reports,
 * alerts the organizer with ids only and audits. Two admins at once make one hold; the second gets the same hold.
 *
 * @throws HttpError invalid_hold, 404 for an unknown target or a removed reward.
 */
export async function unpublish(
  pool: Pool,
  admin: Admin,
  input: HoldInput & Readonly<{ reasonCode: HoldReason }>,
  requestId: string,
): Promise<Readonly<{ outcome: string; holdId: string }>> {
  const row = await moderation<{ outcome: string; hold_id: string }>(
    pool,
    admin,
    "SELECT to_jsonb(x) AS r FROM admin_unpublish($1, $2, $3, $4, $5) x",
    [input.kind, input.targetId, input.reasonCode, input.note, requestId],
  );
  return { outcome: row.outcome, holdId: row.hold_id };
}

/** Publishes a held item again. @throws HttpError not_unpublished (409), invalid_hold, 404. */
export async function republish(
  pool: Pool,
  admin: Admin,
  input: HoldInput,
  requestId: string,
): Promise<void> {
  const outcome = await moderation<string>(
    pool,
    admin,
    "SELECT admin_republish($1, $2, $3, $4) AS r",
    [input.kind, input.targetId, input.note, requestId],
  );
  if (outcome === "not_unpublished") {
    throw notUnpublished();
  }
}

/** The open anti-cheat flags of every event, grouped (`console_flags`, audited). */
export async function readFlags(pool: Pool, admin: Admin, requestId: string): Promise<FlagsAnswer> {
  const raw = await moderation<unknown>(pool, admin, "SELECT console_flags($1) AS r", [requestId]);
  return flagsAnswerSchema.parse(raw);
}
