import type { Pool, PoolClient } from "pg";
import { withRequestContext } from "#src/db/context";
import { withPreIdentityContext } from "#src/db/pre-identity";
import { hashToken } from "#src/auth/keys";
import { AUTH_LIMITS, sessionLimitsFor } from "#src/auth/limits";
import {
  findSession,
  listLiveSessions,
  listMemberships,
  readAccount,
  revokeAllSessions,
  revokeSessionById,
  touchSession,
  type Membership,
  type PublicAccount,
  type SessionSummary,
} from "#src/auth/staff-store";

export const SESSION_COOKIE = "__Host-qs_session";

const TOKEN_FORMAT = /^[A-Za-z0-9_-]{43}$/;

export type Authenticated =
  | Readonly<{ kind: "valid"; sessionId: string; account: PublicAccount }>
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "expired" }>;

export type Sessions = Readonly<{
  /** Checks a session token. Ends the session when it is idle, too old, or its user was disabled. */
  authenticate: (token: string) => Promise<Authenticated>;
  list: (
    staffUserId: string,
    platformRole: PublicAccount["platformRole"],
  ) => Promise<SessionSummary[]>;
  /** Ends one of the user's own sessions. False when there is no such live session. */
  revoke: (staffUserId: string, sessionId: string) => Promise<boolean>;
  /** Ends all of the user's sessions (password change or reset, forced sign-out). */
  revokeAll: (staffUserId: string) => Promise<number>;
  memberships: (staffUserId: string) => Promise<Membership[]>;
}>;

async function withClient<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    return await work(client);
  } finally {
    client.release();
  }
}

const asUser = <T>(pool: Pool, staffUserId: string, work: (client: PoolClient) => Promise<T>) =>
  withClient(pool, (client) => withRequestContext(client, { staffUserId }, () => work(client)));

/**
 * Reads the session and its user, ends it if it should not live on, and records activity at most once a
 * minute. Idle and maximum age come from the user's current role, so a promotion or demotion applies at once.
 */
async function authenticate(pool: Pool, token: string): Promise<Authenticated> {
  if (!TOKEN_FORMAT.test(token)) {
    return { kind: "none" };
  }
  return withClient(pool, (client) =>
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
        if (account === undefined) {
          return { kind: "none" };
        }
        const limits = sessionLimitsFor(account.platformRole);
        const lapsed =
          session.revoked ||
          account.status !== "active" ||
          session.idleSeconds > limits.idleSeconds ||
          session.ageSeconds > limits.maxAgeSeconds;
        if (lapsed) {
          await revokeSessionById(client, session.id);
          return { kind: "expired" };
        }
        if (session.idleSeconds > AUTH_LIMITS.touchIntervalSeconds) {
          await touchSession(client, session.id);
        }
        return { kind: "valid", sessionId: session.id, account };
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
        listLiveSessions(client, sessionLimitsFor(platformRole)),
      ),
    revoke: (staffUserId, sessionId) =>
      asUser(pool, staffUserId, (client) => revokeSessionById(client, sessionId)),
    revokeAll: (staffUserId) => asUser(pool, staffUserId, (client) => revokeAllSessions(client)),
    memberships: (staffUserId) => asUser(pool, staffUserId, (client) => listMemberships(client)),
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
