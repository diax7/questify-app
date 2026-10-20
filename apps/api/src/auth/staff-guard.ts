import type { FastifyReply, FastifyRequest } from "fastify";
import { csrfRejected, sessionExpired, unauthenticated } from "#src/auth/http-errors";
import { SESSION_COOKIE, clearedSessionCookie, readCookie, type Sessions } from "#src/auth/session";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Cookie requests that change something must come from the dashboard's own origin. Browsers always send
 * Origin on such requests; sign-in steps carry no cookie yet, so they only refuse a *different* origin.
 *
 * @throws HttpError `csrf_rejected` when the origin is missing (and a cookie is required) or different.
 */
export function checkOrigin(
  request: FastifyRequest,
  origin: string,
  cookieRequired: boolean,
): void {
  if (SAFE_METHODS.has(request.method)) {
    return;
  }
  const sent = request.headers.origin;
  if (sent === undefined ? cookieRequired : sent !== origin) {
    throw csrfRejected();
  }
}

/**
 * Accepts the request only with a live staff session, and records who it is on the request. A dead session's
 * cookie is cleared.
 *
 * @throws HttpError `unauthenticated` (no session) or `session_expired`.
 */
export async function requireSession(
  request: FastifyRequest,
  reply: FastifyReply,
  sessions: Sessions,
): Promise<void> {
  const token = readCookie(request.headers.cookie, SESSION_COOKIE);
  if (token === undefined) {
    throw unauthenticated();
  }
  const result = await sessions.authenticate(token);
  if (result.kind === "valid") {
    request.staff = { account: result.account, sessionId: result.sessionId };
    request.principalId = result.account.id;
    return;
  }
  reply.header("set-cookie", clearedSessionCookie());
  throw result.kind === "none" ? unauthenticated() : sessionExpired();
}
