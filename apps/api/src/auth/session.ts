import type { Pool, PoolClient } from "pg";
import type { AuditMeta } from "#src/audit/record";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import { withPreIdentityContext } from "#src/db/pre-identity";
import { hashToken } from "#src/auth/keys";
import { AUTH_LIMITS, sessionLimitsFor } from "#src/auth/limits";
import {
  endLookedUpSession,
  findSession,
  listLiveSessions,
  listMemberships,
  readAccount,
  sessionFreshUntil,
  touchSession,
  type Membership,
  type PublicAccount,
  type SessionSummary,
} from "#src/auth/staff-store";

export const SESSION_COOKIE = "__Host-qs_session";

const TOKEN_FORMAT = /^[A-Za-z0-9_-]{43}$/;

export type Authenticated =
  | Readonly<{ kind: "valid"; sessionId: string; tokenHash: string; account: PublicAccount }>
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "expired" }>;

export type Sessions = Readonly<{
  /** Checks a session token. Ends the session when it is idle, too old, or its user was disabled. */
  authenticate: (token: string) => Promise<Authenticated>;
  list: (
    staffUserId: string,
    platformRole: PublicAccount["platformRole"],
  ) => Promise<SessionSummary[]>;
  /** This session's fresh end (sign-in or re-authentication in the last 10 minutes), or null. */
  freshUntil: (staffUserId: string, sessionId: string) => Promise<Date | null>;
  /**
   * Ends one of the user's own sessions (`end_own_staff_session`, migration 0155): this one is a sign-out, another
   * needs this session fresh. Audited in the database.
   */
  end: (who: SessionOwner, target: string, meta?: AuditMeta) => Promise<EndOutcome>;
  /** Ends every other live session of the user after the fresh check (`end_other_staff_sessions`). */
  endOthers: (who: SessionOwner, meta?: AuditMeta) => Promise<EndOthersOutcome>;
  memberships: (staffUserId: string) => Promise<Membership[]>;
}>;

/** The caller of a session door: the user and the hash of the request's own session token. */
export type SessionOwner = Readonly<{ staffUserId: string; tokenHash: string }>;

export type EndOutcome = "ended" | "not_found" | "reauth_required";
export type EndOthersOutcome =
  | Readonly<{ kind: "ended"; ended: number }>
  | Readonly<{ kind: "reauth_required" }>;

const asUser = <T>(pool: Pool, staffUserId: string, work: (client: PoolClient) => Promise<T>) =>
  withConnection(pool, (client) => withRequestContext(client, { staffUserId }, () => work(client)));

/**
 * Reads the session and its user, ends it if it should not live on, and records activity at most once a
 * minute. Idle and maximum age come from the user's current role, so a promotion or demotion applies at once.
 */
async function authenticate(pool: Pool, token: string): Promise<Authenticated> {
  if (!TOKEN_FORMAT.test(token)) {
    return { kind: "none" };
  }
  return withConnection(pool, (client) =>
    withPreIdentityContext(
      client,
      { kind: "session", tokenHash: hashToken(token) },
      async ({ promote }): Promise<Authenticated> => {
        const session = await findSession(client);
        if (session === undefined) {
          return { kind: "none" };
        }
        await promote(session.staffUserId);
        const account = await readAccount(client, session.staffUserId);
        // Stryker disable next-line ConditionalExpression: unreachable: a session row cannot outlive its user (the foreign key cascades)
        if (account === undefined) {
          return { kind: "none" };
        }
        const limits = sessionLimitsFor(account.platformRole);
        const lapsed =
          session.revoked ||
          account.status !== "active" ||
          // Stryker disable next-line EqualityOperator: equivalent: the compared values are fractional seconds from a moving clock and are never exactly equal
          session.idleSeconds > limits.idleSeconds ||
          // Stryker disable next-line EqualityOperator: equivalent: fractional seconds from a moving clock are never exactly equal
          session.ageSeconds > limits.maxAgeSeconds;
        if (lapsed) {
          await endLookedUpSession(client, session.id);
          return { kind: "expired" };
        }
        // Stryker disable next-line EqualityOperator: equivalent: fractional seconds from a moving clock are never exactly equal
        if (session.idleSeconds > AUTH_LIMITS.touchIntervalSeconds) {
          await touchSession(client, session.id);
        }
        return { kind: "valid", sessionId: session.id, tokenHash: hashToken(token), account };
      },
    ),
  );
}

/** The staff session service: check, list, end. */
export function createSessions(pool: Pool): Sessions {
  return {
    authenticate: (token) => authenticate(pool, token),
    list: (staffUserId, platformRole) =>
      asUser(pool, staffUserId, (client) =>
        listLiveSessions(client, staffUserId, sessionLimitsFor(platformRole)),
      ),
    freshUntil: (staffUserId, sessionId) =>
      asUser(pool, staffUserId, (client) => sessionFreshUntil(client, sessionId)),
    end: (who, target, meta = {}) =>
      asUser(pool, who.staffUserId, async (client) => {
        const { rows } = await client.query<{ outcome: EndOutcome }>(
          "SELECT end_own_staff_session(decode($1, 'hex'), $2, $3) AS outcome",
          [who.tokenHash, target, meta.requestId ?? null],
        );
        return rows[0]?.outcome ?? "not_found";
      }),
    endOthers: (who, meta = {}) =>
      asUser(pool, who.staffUserId, async (client) => {
        const { rows } = await client.query<{
          outcome: "ended" | "reauth_required";
          ended: number;
        }>("SELECT outcome, ended FROM end_other_staff_sessions(decode($1, 'hex'), $2)", [
          who.tokenHash,
          meta.requestId ?? null,
        ]);
        const row = rows[0];
        return row?.outcome === "ended"
          ? { kind: "ended", ended: row.ended }
          : { kind: "reauth_required" };
      }),
    memberships: (staffUserId) =>
      asUser(pool, staffUserId, (client) => listMemberships(client, staffUserId)),
  };
}

// ---------------------------------------------------------------- cookie

/** Reads one cookie from a Cookie header. Returns undefined when it is absent. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) {
    return undefined;
  }
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator !== -1 && part.slice(0, separator).trim() === name) {
      return part.slice(separator + 1).trim();
    }
  }
  return undefined;
}

const ATTRIBUTES = "Path=/; HttpOnly; Secure; SameSite=Strict";

/** The Set-Cookie value that opens the session. `__Host-` needs Secure, Path=/ and no Domain. */
export function sessionCookie(token: string, maxAgeSeconds: number): string {
  return `${SESSION_COOKIE}=${token}; ${ATTRIBUTES}; Max-Age=${maxAgeSeconds}`;
}

/** The Set-Cookie value that removes the session cookie, with the same attributes it was set with. */
export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; ${ATTRIBUTES}; Max-Age=0`;
}
