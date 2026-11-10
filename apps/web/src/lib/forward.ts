import {
  forwardedRequestHeaders,
  forwardedResponseHeaders,
  readCapped,
  refusal,
} from "#src/lib/forward-headers.ts";
import {
  authStepOf,
  clearedPlayerCookie,
  isOperatorPath,
  originRefused,
  readPlayerCookie,
  takesBearer,
  type PlayerCookie,
} from "#src/lib/player-session.ts";
import { playerStep } from "#src/lib/player-steps.ts";

/** Encoded dots, slashes and backslashes could walk a decoded path out of `/v1`. */
const ENCODED_PATH_TRICK = /%2e|%2f|%5c/i;

export type ForwardOptions = Readonly<{
  apiOrigin: string;
  timeoutMs: number;
  maxBodyBytes: number;
  /** Receives only the method, path and reason of a failure: never a body, a cookie or a query. */
  log: (fields: Readonly<Record<string, string>>) => void;
  fetchImpl?: typeof fetch;
  /** The web app's own origin (`DASHBOARD_ORIGIN`): the Origin a cookie write or a sign-in step must send (ADR-819). */
  webOrigin: string;
  /**
   * `PLAYER_WEB_SESSION`: the player cookie steps (ADR-818). Off, no player cookie is set, read or turned into a
   * bearer, and the sign-in steps pass through as before; the SECURITY.md ship gate keeps it off until P3's CSP.
   */
  playerSession: boolean;
}>;

/** The API address for this request, or undefined when the path is not a plain `/v1/...` path. */
function targetOf(request: Request, apiOrigin: string): URL | undefined {
  const incoming = new URL(request.url);
  if (!incoming.pathname.startsWith("/v1/") || ENCODED_PATH_TRICK.test(incoming.pathname)) {
    return undefined;
  }
  const target = new URL(incoming.pathname + incoming.search, apiOrigin);
  return target.origin === new URL(apiOrigin).origin && target.pathname.startsWith("/v1/")
    ? target
    : undefined;
}

/** The browser's body, capped; or the forwarder's refusal when it is too long or breaks off. */
async function bodyOf(
  request: Request,
  path: string,
  options: ForwardOptions,
): Promise<Uint8Array<ArrayBuffer> | Response | undefined> {
  if (request.body === null || request.method === "GET" || request.method === "HEAD") {
    return undefined;
  }
  let body: Uint8Array<ArrayBuffer> | undefined;
  try {
    body = await readCapped(request.body, options.maxBodyBytes);
  } catch {
    options.log({
      event: "api_forward_failed",
      method: request.method,
      path,
      reason: "body_unreadable",
    });
    return refusal("invalid_request");
  }
  return body ?? refusal("payload_too_large");
}

/** The bearer for this request: the cookie's access token, only with the switch on and only on player paths. */
const bearerOf = (cookie: PlayerCookie, path: string, options: ForwardOptions) =>
  options.playerSession && takesBearer(path) ? cookie.pair?.access : undefined;

/** The API's answer for the browser; a player cookie sent twice is cleared on the way back. */
function answerOf(upstream: Response, request: Request, clearCookie: boolean): Response {
  const empty = upstream.status === 204 || upstream.status === 304 || request.method === "HEAD";
  const headers = forwardedResponseHeaders(upstream.headers);
  if (clearCookie) {
    headers.append("set-cookie", clearedPlayerCookie());
  }
  return new Response(empty ? null : upstream.body, { status: upstream.status, headers });
}

/** Passes one request to the API and its answer back, the player cookie never in either direction. */
async function passThrough(
  request: Request,
  target: URL,
  cookie: PlayerCookie,
  options: ForwardOptions,
): Promise<Response> {
  const body = await bodyOf(request, target.pathname, options);
  if (body instanceof Response) {
    return body;
  }
  try {
    const upstream = await (options.fetchImpl ?? fetch)(target, {
      method: request.method,
      headers: forwardedRequestHeaders(
        request.headers,
        cookie,
        bearerOf(cookie, target.pathname, options),
      ),
      ...(body === undefined ? {} : { body }),
      redirect: "manual",
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    return answerOf(upstream, request, options.playerSession && cookie.duplicate);
  } catch (error) {
    const reason =
      error instanceof Error && error.name === "TimeoutError" ? "timeout" : "unreachable";
    options.log({
      event: "api_forward_failed",
      method: request.method,
      path: target.pathname,
      reason,
    });
    return refusal("api_unavailable");
  }
}

/**
 * Forwards one browser request to the API (same origin for the browser, so the `__Host-` cookies and
 * `SameSite=Strict` work without CORS). Never retries: sign-in steps are not safe to repeat. With the player web
 * session on, the forwarder answers the player's verify, signup, refresh and logout itself (`playerStep`) and turns
 * the player cookie into a bearer token on player paths.
 */
export async function forward(request: Request, options: ForwardOptions): Promise<Response> {
  const target = targetOf(request, options.apiOrigin);
  if (target === undefined) {
    return refusal("not_found");
  }
  const cookie = readPlayerCookie(request.headers.get("cookie"));
  if (originRefused(request, target.pathname, cookie, options.webOrigin)) {
    return refusal("csrf_rejected");
  }
  if (options.playerSession) {
    const step = authStepOf(request.method, target.pathname);
    if (step !== undefined) {
      return playerStep(step, request, target.pathname, cookie, options);
    }
    if (cookie.present && isOperatorPath(target.pathname)) {
      return refusal("not_found");
    }
  }
  return passThrough(request, target, cookie, options);
}
