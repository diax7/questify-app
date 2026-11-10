import {
  forwardedRequestHeaders,
  forwardedResponseHeaders,
  ownAnswer,
  readCapped,
  refusal,
} from "#src/lib/forward-headers.ts";
import {
  clearedPlayerCookie,
  issuedPairOf,
  playerCookie,
  type AuthStep,
  type PlayerCookie,
  type PlayerPair,
} from "#src/lib/player-session.ts";

/** A sign-in or sign-up body is small; anything longer is refused before the API is called. */
export const SIGN_IN_BODY_BYTES = 2_048;

export type StepOptions = Readonly<{
  apiOrigin: string;
  timeoutMs: number;
  /** Receives only the method, path and reason of a failure: never a body, a cookie or a token. */
  log: (fields: Readonly<Record<string, string>>) => void;
  fetchImpl?: typeof fetch;
}>;

type StepContext = Readonly<{ request: Request; cookie: PlayerCookie; options: StepOptions }>;

type Called = Response | "timeout" | "unreachable";

/** One JSON POST of the forwarder's own to the API, with the person's address, agent and language. */
async function callApi(context: StepContext, path: string, body: unknown): Promise<Called> {
  const headers = forwardedRequestHeaders(context.request.headers, context.cookie);
  headers.set("content-type", "application/json");
  // The forwarder's own calls are its own requests, not a replay or a revalidation of the browser's.
  headers.delete("idempotency-key");
  headers.delete("if-none-match");
  try {
    return await (context.options.fetchImpl ?? fetch)(new URL(path, context.options.apiOrigin), {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      // The forwarder's own calls: the API never redirects, so one is a failure (ADR-701).
      redirect: "error",
      signal: AbortSignal.timeout(context.options.timeoutMs),
    });
  } catch (error) {
    return error instanceof Error && error.name === "TimeoutError" ? "timeout" : "unreachable";
  }
}

const logFailure = (context: StepContext, path: string, reason: string) =>
  context.options.log({ event: "api_forward_failed", method: "POST", path, reason });

/**
 * Ends the family of the cookie the browser holds (`POST /v1/auth/logout`). A failure is only logged.
 *
 * @returns whether the API answered 2xx, so the cookie is dead.
 */
async function endFamily(context: StepContext, pair: PlayerPair): Promise<boolean> {
  const path = "/v1/auth/logout";
  const answer = await callApi(context, path, { refreshToken: pair.refresh });
  if (typeof answer === "string") {
    logFailure(context, path, answer);
    return false;
  }
  await answer.body?.cancel();
  if (!answer.ok) {
    logFailure(context, path, `status_${answer.status}`);
  }
  return answer.ok;
}

const parsedJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/** Reads at most `limit` bytes of the browser's body as JSON; why not when it cannot. */
async function browserJson(
  request: Request,
  limit: number,
): Promise<Record<string, unknown> | "invalid_request" | "payload_too_large"> {
  if (request.body === null) {
    return "invalid_request";
  }
  let bytes: Uint8Array | undefined;
  try {
    bytes = await readCapped(request.body, limit);
  } catch {
    return "invalid_request";
  }
  if (bytes === undefined) {
    return "payload_too_large";
  }
  const parsed = parsedJson(new TextDecoder().decode(bytes));
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : "invalid_request";
}

const isSignupStep = (body: unknown): boolean =>
  typeof body === "object" &&
  body !== null &&
  typeof (body as Record<string, unknown>)["signupToken"] === "string" &&
  issuedPairOf(body) === undefined &&
  !("accessToken" in body) &&
  !("refreshToken" in body);

type Issued = Readonly<{ allowSignupStep: boolean; failCookies: readonly string[] }>;

/**
 * The API's answer to verify, signup or refresh, rebuilt: a token pair becomes the cookie and `{ signedIn: true,
 * expiresInSeconds, player }`, so no token reaches the page; an error passes with its status and body; a 2xx with no
 * pair (other than verify's sign-up step) is a broken answer, 502.
 */
async function issuedAnswer(upstream: Response, how: Issued): Promise<Response> {
  const body = parsedJson(await upstream.text());
  if (!upstream.ok) {
    return ownAnswer(
      upstream.status,
      body ?? null,
      how.failCookies,
      forwardedResponseHeaders(upstream.headers),
    );
  }
  const pair = issuedPairOf(body);
  if (pair !== undefined) {
    const { expiresInSeconds, player } = body as Record<string, unknown>;
    return ownAnswer(upstream.status, { signedIn: true, expiresInSeconds, player }, [
      playerCookie(pair),
    ]);
  }
  if (how.allowSignupStep && isSignupStep(body)) {
    return ownAnswer(upstream.status, body, how.failCookies);
  }
  return refusal("api_unavailable", how.failCookies);
}

/**
 * Step 1, `POST /v1/auth/verify` and `/signup`: the device is always `web` (ADR-820), and a cookie the browser still
 * holds is logged out first, so that orphan family never counts in the 10 (ADR-717).
 */
async function signInStep(context: StepContext, path: string): Promise<Response> {
  const body = await browserJson(context.request, SIGN_IN_BODY_BYTES);
  if (typeof body === "string") {
    return refusal(body);
  }
  const { pair, duplicate } = context.cookie;
  const ended = pair !== undefined && (await endFamily(context, pair));
  const failCookies = ended || duplicate ? [clearedPlayerCookie()] : [];
  const upstream = await callApi(context, path, { ...body, device: { platform: "web" } });
  if (typeof upstream === "string") {
    logFailure(context, path, upstream);
    return refusal("api_unavailable", failCookies);
  }
  return issuedAnswer(upstream, { allowSignupStep: path === "/v1/auth/verify", failCookies });
}

/**
 * Step 2, `POST /v1/auth/refresh`: the browser's body is ignored. A 401 ends the cookie (`session_expired`); a
 * timeout, a 5xx or no answer leaves it, inside the API's 60-second grace.
 */
async function refreshStep(context: StepContext, path: string): Promise<Response> {
  const { pair, present } = context.cookie;
  if (pair === undefined) {
    return refusal("unauthenticated", present ? [clearedPlayerCookie()] : []);
  }
  const upstream = await callApi(context, path, { refreshToken: pair.refresh });
  if (typeof upstream === "string") {
    logFailure(context, path, upstream);
    return refusal("api_unavailable");
  }
  if (upstream.status === 401) {
    await upstream.body?.cancel();
    return refusal("session_expired", [clearedPlayerCookie()]);
  }
  return issuedAnswer(upstream, { allowSignupStep: false, failCookies: [] });
}

/** Step 3, `POST /v1/auth/logout`: always 204 with the cookie cleared, whatever the API answered. */
async function logoutStep(context: StepContext): Promise<Response> {
  if (context.cookie.pair !== undefined) {
    await endFamily(context, context.cookie.pair);
  }
  return ownAnswer(204, null, [clearedPlayerCookie()]);
}

/** Answers one of the player sign-in steps the forwarder holds the cookie for. */
export function playerStep(
  step: AuthStep,
  request: Request,
  path: string,
  cookie: PlayerCookie,
  options: StepOptions,
): Promise<Response> {
  const context = { request, cookie, options };
  switch (step) {
    case "sign_in":
      return signInStep(context, path);
    case "refresh":
      return refreshStep(context, path);
    case "logout":
      return logoutStep(context);
  }
}
