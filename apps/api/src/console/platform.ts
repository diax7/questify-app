import {
  adminAccountsSchema,
  evaluateHealth,
  healthFactsSchema,
  platformNumbersSchema,
  type AdminAccount,
  type AdminSession,
  type HealthView,
  type PlatformNumbers,
  type Transports,
} from "@questify/shared";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { recordAudit } from "#src/audit/record";
import { sessionLimitsFor } from "#src/auth/limits";
import { door, type Admin } from "#src/console/doors";

const ADMIN_LIMITS = sessionLimitsFor("admin");

const sessionRowsSchema = z.array(
  z.strictObject({
    id: z.uuid(),
    createdAt: z.string(),
    lastSeenAt: z.string(),
    userAgent: z.string().nullable(),
    ip: z.string().nullable(),
  }),
);

/** The one answer a read door gives, as the JSON the database built. */
export async function answerOf(
  client: PoolClient,
  sql: string,
  values: unknown[] = [],
): Promise<unknown> {
  const { rows } = await client.query<{ r: unknown }>(sql, values);
  return rows[0]?.r;
}

const iso = (value: string): string => new Date(value).toISOString();

/**
 * The health view (T-709, FR-1783): the door's counts and flags (`console_health`, migration 0117) checked against a
 * strict shape and turned into six tiles with this server's set-up. Counts only, nothing audited. `databaseMs` is how
 * long the door took, connection included, so a slow database shows in the first tile.
 */
export async function readHealth(
  pool: Pool,
  admin: Admin,
  transports: Transports,
): Promise<HealthView> {
  const started = performance.now();
  const answer = await door(pool, admin, (client) =>
    answerOf(client, "SELECT console_health() AS r"),
  );
  const databaseMs = Math.round(performance.now() - started);
  return evaluateHealth(healthFactsSchema.parse(answer), transports, databaseMs, new Date());
}

/** The platform numbers (T-709, FR-1419): counts of organizers, events, players, staff and the last hour's activity. */
export async function readNumbers(pool: Pool, admin: Admin): Promise<PlatformNumbers> {
  const answer = await door(pool, admin, (client) =>
    answerOf(client, "SELECT console_numbers() AS r"),
  );
  return platformNumbersSchema.parse(answer);
}

/**
 * Platform admins with the number of sessions each has open. The list shows staff emails, so a read writes one audit
 * entry with the account ids shown (ids only, as the organizers list does).
 */
export function readAdminAccounts(
  pool: Pool,
  admin: Admin,
  requestId: string,
): Promise<AdminAccount[]> {
  return door(pool, admin, async (client) => {
    const answer = await answerOf(client, "SELECT console_admin_accounts($1, $2) AS r", [
      ADMIN_LIMITS.idleSeconds,
      ADMIN_LIMITS.maxAgeSeconds,
    ]);
    const { admins } = adminAccountsSchema.parse({ admins: answer });
    await recordAudit(client, {
      actor: { type: "admin", id: admin.id },
      action: "console.admins_read",
      target: { type: "staff_user" },
      after: { adminIds: admins.map((account) => account.id) },
      requestId,
    });
    return admins.map((account) => ({
      ...account,
      createdAt: iso(account.createdAt),
      lastSeenAt: account.lastSeenAt === null ? null : iso(account.lastSeenAt),
    }));
  });
}

/**
 * One admin's open sessions with their browser and address, so a lost laptop can be told from a phone. The read writes
 * one audit entry naming the account. `current` marks the session that asked, which cannot be ended from here.
 */
export function readAdminSessions(
  pool: Pool,
  admin: Admin,
  input: Readonly<{ staffUserId: string; currentSessionId: string; requestId: string }>,
): Promise<AdminSession[]> {
  return door(pool, admin, async (client) => {
    const answer = await answerOf(client, "SELECT console_admin_sessions($1, $2, $3) AS r", [
      input.staffUserId,
      ADMIN_LIMITS.idleSeconds,
      ADMIN_LIMITS.maxAgeSeconds,
    ]);
    await recordAudit(client, {
      actor: { type: "admin", id: admin.id },
      action: "console.admin_sessions_read",
      target: { type: "staff_user", id: input.staffUserId },
      requestId: input.requestId,
    });
    return sessionRowsSchema.parse(answer).map((session) => ({
      ...session,
      createdAt: iso(session.createdAt),
      lastSeenAt: iso(session.lastSeenAt),
      current: session.id === input.currentSessionId,
    }));
  });
}

/** Ends one open session of a platform admin at once, with a reason; audited by the door (`staff.session.force_end`). */
export function endAdminSession(
  pool: Pool,
  admin: Admin,
  input: Readonly<{ sessionId: string; reason: string; requestId: string }>,
): Promise<void> {
  return door(pool, admin, async (client) => {
    await client.query("SELECT admin_end_session($1, $2, $3)", [
      input.sessionId,
      input.reason,
      input.requestId,
    ]);
  });
}
