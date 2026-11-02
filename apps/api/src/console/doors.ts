import type { Pool, PoolClient } from "pg";
import {
  alreadyInThatState,
  invalidReason,
  notFound,
  supportBusy,
  supportMember,
  tooManySupportGrants,
} from "#src/auth/http-errors";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import type { HttpError } from "#src/http-error";

type Admin = Readonly<{ id: string }>;

export type SuspendTarget = Readonly<{ kind: "organizer" | "event"; id: string }>;

export type OpenedGrant = Readonly<{
  grantId: string;
  organizerId: string;
  eventId: string;
  expiresAt: string;
}>;

/**
 * Each refusal of the console doors (migration 0114) as its HTTP answer. A caller who is not an admin, and a missing
 * organizer, event or live grant, all look like nothing there (404).
 */
const REFUSALS: Readonly<Record<string, () => HttpError>> = {
  QE403: notFound,
  QA404: notFound,
  SG404: notFound,
  SU400: invalidReason,
  SU409: alreadyInThatState,
  SG409: supportMember,
  SG429: tooManySupportGrants,
  // Two opens of the same event at once: the unique index keeps one.
  "23505": supportBusy,
};

/** Runs a console door in the admin's seat; one of its refusals comes back as an HttpError, anything else rethrows. */
async function door<T>(pool: Pool, admin: Admin, work: (client: PoolClient) => Promise<T>) {
  try {
    return await withConnection(pool, (client) =>
      withRequestContext(client, { isAdmin: true, staffUserId: admin.id }, () => work(client)),
    );
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

/** Suspends an organizer or one event (ADR-406): an overlay, audited by the door with the reason. */
export function suspend(
  pool: Pool,
  admin: Admin,
  target: SuspendTarget,
  input: Readonly<{ reason: string; requestId: string }>,
): Promise<string> {
  return door(pool, admin, async (client) => {
    const { rows } = await client.query<{ at: Date }>(
      `SELECT admin_suspend_${target.kind}($1, $2, $3) AS at`,
      [target.id, input.reason, input.requestId],
    );
    // Stryker disable next-line OptionalChaining: the door answers one row or raises
    return rows[0]?.at.toISOString() ?? "";
  });
}

/** Lifts a suspension; what was there before is exactly what comes back. */
export function reactivate(
  pool: Pool,
  admin: Admin,
  target: SuspendTarget,
  requestId: string,
): Promise<void> {
  return door(pool, admin, async (client) => {
    await client.query(`SELECT admin_reactivate_${target.kind}($1, $2)`, [target.id, requestId]);
  });
}

/** Opens 15 minutes of support on one event for the calling admin (ADR-407). */
export function openSupport(
  pool: Pool,
  admin: Admin,
  input: Readonly<{ eventId: string; reason: string; requestId: string }>,
): Promise<OpenedGrant> {
  return door(pool, admin, async (client) => {
    const { rows } = await client.query<{
      grant_id: string;
      organizer_id: string;
      event_id: string;
      expires_at: Date;
    }>("SELECT * FROM support_open($1, $2, $3)", [input.eventId, input.reason, input.requestId]);
    const row = rows[0];
    // Stryker disable next-line ConditionalExpression,BlockStatement: unreachable: the door answers one row or raises
    if (row === undefined) {
      throw new Error("support_open answered no row; check migration 0114");
    }
    return {
      grantId: row.grant_id,
      organizerId: row.organizer_id,
      eventId: row.event_id,
      expiresAt: row.expires_at.toISOString(),
    };
  });
}

/** Closes a live grant from the admin side (any active admin may). */
export function closeSupport(
  pool: Pool,
  admin: Admin,
  grantId: string,
  requestId: string,
): Promise<void> {
  return door(pool, admin, async (client) => {
    await client.query("SELECT support_close($1, $2)", [grantId, requestId]);
  });
}
