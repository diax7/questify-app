import type { FastifyReply, FastifyRequest } from "fastify";
import {
  csrfRejected,
  hiddenNotFound,
  sessionExpired,
  unauthenticated,
} from "#src/auth/http-errors";
import { SESSION_COOKIE, clearedSessionCookie, readCookie, type Sessions } from "#src/auth/session";
import type { Surface } from "#src/auth/staff-store";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** The two browser origins of the web app (T-810d, ADR-723): the public host and the console's own host. */
export type StaffOrigins = Readonly<Record<Surface, string>>;

/**
 * Cookie requests that change something must come from the dashboard's own origin. Browsers always send
 * Origin on such requests; sign-in steps carry no cookie yet, so they only refuse a *different* origin.
 * The device doors use it; the staff session doors use `checkCaller` and `checkSessionOrigin`.
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

/** What a browser says about who started a request; `same-site` is the other host of the web app (T-810d). */
const OTHER_HOST_FETCH = new Set(["same-site", "cross-site"]);

/**
 * The check a staff session door runs **before** the session lookup, so a refused request never reaches a session:
 * it neither refreshes the idle clock nor spends the session's limits (T-810d plan review 86, item 1). The public
 * host and the console host are the same site, so `SameSite=Strict` lets either page send the other's cookie; the
 * browser's `Sec-Fetch-Site` and `Origin` tell them apart.
 * - Every method: a fetch the browser marks `same-site` or `cross-site` is refused, and so is an Origin outside
 *   `allowed`. A request with neither header (a server render, the app, an old browser) passes this step.
 * - Unsafe methods: Origin is required when the door needs a cookie.
 *
 * @throws HttpError `csrf_rejected`.
 */
export function checkCaller(
  request: FastifyRequest,
  allowed: readonly string[],
  cookieRequired: boolean,
): void {
  const site = request.headers["sec-fetch-site"];
  if (typeof site === "string" && OTHER_HOST_FETCH.has(site)) {
    throw csrfRejected();
  }
  const sent = request.headers.origin;
  if (sent === undefined) {
    if (cookieRequired && !SAFE_METHODS.has(request.method)) {
      throw csrfRejected();
    }
    return;
  }
  if (!allowed.includes(sent)) {
    throw csrfRejected();
  }
}

/**
 * After the session lookup: a request that carries an Origin must carry its own session's (ADR-721), so a page on one
 * host can never drive the other host's session.
 *
 * @throws HttpError `csrf_rejected`.
 */
export function checkSessionOrigin(request: FastifyRequest, origins: StaffOrigins): void {
  const sent = request.headers.origin;
  const surface = request.staff?.surface;
  if (sent !== undefined && (surface === undefined || sent !== origins[surface])) {
    throw csrfRejected();
  }
}

/**
 * The surface a sign-in opens (ADR-720): `console` only when the request comes from the console's own origin;
 * anything else, a missing Origin included, is the lesser `dashboard`.
 */
export function surfaceOf(request: FastifyRequest, origins: StaffOrigins): Surface {
  return request.headers.origin === origins.console ? "console" : "dashboard";
}

/**
 * A door that takes one surface only refuses the other with its hidden 404, logged as `authz.denied` with the reason
 * `wrong_surface` (ADR-703, ADR-720).
 *
 * @throws HttpError 404 `not_found`.
 */
export function requireSurface(request: FastifyRequest, surface: Surface): void {
  if (request.staff?.surface !== surface) {
    throw hiddenNotFound("wrong_surface");
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
    request.staff = {
      account: result.account,
      sessionId: result.sessionId,
      tokenHash: result.tokenHash,
      surface: result.surface,
    };
    request.principalId = result.account.id;
    return;
  }
  reply.header("set-cookie", clearedSessionCookie());
  throw result.kind === "none" ? unauthenticated() : sessionExpired();
}
