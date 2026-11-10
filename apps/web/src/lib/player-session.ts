/**
 * The player's web session, held by the forwarder (T-803 P2, ADR-818, plan `docs/plans/2026-11-10-t-803-p2-web-session.md`).
 * The API's player contract stays bearer only: the forwarder keeps the access and refresh tokens in one host-only,
 * HttpOnly cookie, takes them out of every answer the browser gets, and turns the cookie back into
 * `Authorization: Bearer` on the way in.
 */

export const PLAYER_COOKIE = "__Host-qs_player";

/** 180 days, set again on each rotation; the API's 365-day end for a family still applies (ADR-706). */
export const PLAYER_COOKIE_MAX_AGE = 15_552_000;

const ATTRIBUTES = "Path=/; HttpOnly; Secure; SameSite=Strict";

/** A token as the API issues it: 32 random bytes in base64url (`generateToken`), 43 characters. */
const TOKEN = /^[A-Za-z0-9_-]{43}$/u;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const APP_VERSION = /^[0-9]+(\.[0-9]+){0,2}$/u;

export type PlayerPair = Readonly<{ access: string; refresh: string }>;

export type PlayerCookie = Readonly<{
  /** The two tokens when exactly one well-formed `__Host-qs_player` was sent. */
  pair: PlayerPair | undefined;
  /** At least one `__Host-qs_player` was sent, well-formed or not. */
  present: boolean;
  /** More than one was sent: no cookie, and the answer clears it. */
  duplicate: boolean;
  /** The request's `Cookie` header without any `__Host-qs_player`; undefined when nothing else is left. */
  others: string | undefined;
}>;

const pairOf = (value: string): PlayerPair | undefined => {
  const [access, refresh, ...rest] = value.split(".");
  return access !== undefined &&
    refresh !== undefined &&
    rest.length === 0 &&
    TOKEN.test(access) &&
    TOKEN.test(refresh)
    ? { access, refresh }
    : undefined;
};

/** Reads the player cookie out of a `Cookie` header and keeps every other cookie (staff, device) as it was. */
export function readPlayerCookie(header: string | null): PlayerCookie {
  const { values, kept } = splitCookies(header);
  const [only] = values;
  return {
    pair: values.length === 1 && only !== undefined ? pairOf(only) : undefined,
    present: values.length > 0,
    duplicate: values.length > 1,
    others: kept.length === 0 ? undefined : kept.join("; "),
  };
}

/** The player cookie's values, and every other cookie entry as it was sent. */
function splitCookies(header: string | null): { values: string[]; kept: string[] } {
  const kept: string[] = [];
  const values: string[] = [];
  for (const entry of (header ?? "").split(";").map((part) => part.trim())) {
    const equals = entry.indexOf("=");
    const isPlayer = equals !== -1 && entry.slice(0, equals).trim() === PLAYER_COOKIE;
    if (isPlayer) {
      values.push(entry.slice(equals + 1).trim());
    } else if (entry !== "") {
      kept.push(entry);
    }
  }
  return { values, kept };
}

/** The cookie for a pair the API just issued. */
export const playerCookie = (pair: PlayerPair): string =>
  `${PLAYER_COOKIE}=${pair.access}.${pair.refresh}; ${ATTRIBUTES}; Max-Age=${PLAYER_COOKIE_MAX_AGE}`;

/** The same cookie, ended. */
export const clearedPlayerCookie = (): string => `${PLAYER_COOKIE}=; ${ATTRIBUTES}; Max-Age=0`;

/** Whether an upstream `Set-Cookie` names the player cookie: only the forwarder may set it. */
export const setsPlayerCookie = (setCookie: string): boolean =>
  setCookie.split("=", 1)[0]?.trim().toLowerCase() === PLAYER_COOKIE.toLowerCase();

/** A token pair in an issued body (`accessToken`, `refreshToken`), or undefined when it holds none of that shape. */
export function issuedPairOf(body: unknown): PlayerPair | undefined {
  if (typeof body !== "object" || body === null) {
    return undefined;
  }
  const { accessToken, refreshToken } = body as Record<string, unknown>;
  return typeof accessToken === "string" &&
    typeof refreshToken === "string" &&
    TOKEN.test(accessToken) &&
    TOKEN.test(refreshToken)
    ? { access: accessToken, refresh: refreshToken }
    : undefined;
}

/** The player sign-in steps the forwarder answers itself when the switch is on. */
export type AuthStep = "sign_in" | "refresh" | "logout";

const STEPS: Readonly<Record<string, AuthStep>> = {
  "/v1/auth/verify": "sign_in",
  "/v1/auth/signup": "sign_in",
  "/v1/auth/refresh": "refresh",
  "/v1/auth/logout": "logout",
};

export const authStepOf = (method: string, pathname: string): AuthStep | undefined =>
  method === "POST" ? STEPS[pathname] : undefined;

/** Operator screens stay phone-only (Q-755): a cookie request to them answers 404. */
export const isOperatorPath = (pathname: string): boolean =>
  pathname.startsWith("/v1/operator/") ||
  pathname === "/v1/me/operator-events" ||
  pathname.startsWith("/v1/me/operator-events/");

/** Paths that never receive the player's bearer: the sign-in steps, staff, admin, kiosk devices and operators. */
const NO_BEARER = ["/v1/auth/", "/v1/staff/", "/v1/admin/", "/v1/device/"];

export const takesBearer = (pathname: string): boolean =>
  pathname !== "/v1/device" &&
  !NO_BEARER.some((prefix) => pathname.startsWith(prefix)) &&
  !isOperatorPath(pathname);

const WRITES = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * The forwarder's Origin rule (ADR-819): a write carrying the player cookie, or any write to `/v1/auth/*`, must send
 * `Origin` equal to the web origin. Stops login CSRF and sibling subdomains, which `SameSite` counts as the same site.
 * Reads change nothing and are not checked; staff paths keep the API's own `checkOrigin` as well.
 */
export function originRefused(
  request: Request,
  pathname: string,
  cookie: PlayerCookie,
  webOrigin: string,
): boolean {
  if (!WRITES.has(request.method)) {
    return false;
  }
  const guarded = cookie.present || pathname.startsWith("/v1/auth/");
  return guarded && request.headers.get("origin") !== webOrigin;
}

/** `X-Device-Id` only when a UUID and `X-App-Version` only in the version shape; anything else is dropped. */
export function appHeaders(incoming: Headers): Readonly<Record<string, string>> {
  const deviceId = incoming.get("x-device-id");
  const appVersion = incoming.get("x-app-version");
  return {
    ...(deviceId !== null && UUID.test(deviceId) ? { "x-device-id": deviceId } : {}),
    ...(appVersion !== null && APP_VERSION.test(appVersion) ? { "x-app-version": appVersion } : {}),
  };
}
