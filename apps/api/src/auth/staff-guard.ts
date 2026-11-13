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

/**
 * The web app's browser origins (T-810d, ADR-723): the public host, and the console's own host once `CONSOLE_ORIGIN` is
 * set. While `console` is undefined every staff door behaves as before the console had a host of its own.
 */
export type StaffOrigins = Readonly<{ dashboard: string; console: string | undefined }>;

/**
 * Cookie requests that change something must come from the dashboard's own origin. Browsers always send
 * Origin on such requests; sign-in steps carry no cookie yet, so they only refuse a *different* origin.
 * The device doors use it, and every staff door while no console origin is set (`guardStaffDoor`).
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
 * The check a staff door runs **before** the session lookup once the console has its own host, so a refused request
 * never reaches a session: it neither refreshes the idle clock nor spends the session's limits (T-810d review 86,
 * item 1). The public host and the console host are the same site, so `SameSite=Strict` lets either page send the
 * other's cookie; the browser's `Sec-Fetch-Site` and `Origin` tell them apart.
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
  if (sent === undefined) {
    return;
  }
  const own = surface === "console" ? origins.console : origins.dashboard;
  if (surface === undefined || sent !== own) {
    throw csrfRejected();
  }
}

/**
 * The surface a sign-in asks for (ADR-720): `console` only when a console origin is set and the request comes from it;
 * anything else, a missing Origin included, is the lesser `dashboard`.
 */
export function surfaceOf(request: FastifyRequest, origins: StaffOrigins): Surface {
  return origins.console !== undefined && request.headers.origin === origins.console
    ? "console"
    : "dashboard";
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

/** The three staff session doors (T-810d): the console, the staff account routes and the organizer dashboard. */
export type StaffDoor = "console" | "staff" | "organizer";

export type StaffDoorDeps = Readonly<{ sessions: Sessions; origins: StaffOrigins }>;

/** The origins a door takes before the lookup once the console has its own host. */
function allowedFor(door: StaffDoor, origins: StaffOrigins & { console: string }): string[] {
  if (door === "console") {
    return [origins.console];
  }
  return door === "organizer" ? [origins.dashboard] : [origins.dashboard, origins.console];
}

/**
 * The staff checks of one door, in order. With no console origin set: the dashboard origin on unsafe methods and the
 * session, exactly as before T-810d. With one set (ADR-720, ADR-721): the caller check before any lookup, the session,
 * then the console door takes only `console` sessions, the organizer door only `dashboard` ones, and the staff routes
 * any session from its own origin. `needsSession` is false only for the public sign-in and reset steps.
 *
 * @throws HttpError `csrf_rejected`, `unauthenticated`, `session_expired`, or the hidden 404.
 */
export async function guardStaffDoor(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: StaffDoorDeps,
  door: Readonly<{ kind: StaffDoor; needsSession: boolean }>,
): Promise<void> {
  const { origins } = deps;
  if (origins.console === undefined) {
    checkOrigin(request, origins.dashboard, door.needsSession);
    if (door.needsSession) {
      await requireSession(request, reply, deps.sessions);
    }
    return;
  }
  checkCaller(
    request,
    allowedFor(door.kind, { ...origins, console: origins.console }),
    door.needsSession,
  );
  if (!door.needsSession) {
    return;
  }
  await requireSession(request, reply, deps.sessions);
  if (door.kind === "console") {
    requireSurface(request, "console");
  } else if (door.kind === "organizer") {
    // The console host never shows a dashboard page, so a console session has no business here (ADR-720).
    requireSurface(request, "dashboard");
  } else {
    checkSessionOrigin(request, origins);
  }
}
