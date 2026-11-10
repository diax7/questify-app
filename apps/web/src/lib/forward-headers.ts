import { API_SECURITY_HEADERS, apiError, type LocalizedText } from "@questify/shared";
import { appHeaders, setsPlayerCookie, type PlayerCookie } from "#src/lib/player-session.ts";

/**
 * Request headers the API needs; everything else (host, `authorization`, the client's own `x-*`) is dropped. `cookie`
 * goes without the player cookie, and `x-device-id` and `x-app-version` only in their shapes (`appHeaders`).
 */
const REQUEST_HEADERS = [
  "content-type",
  "origin",
  "idempotency-key",
  "if-none-match",
  "accept-language",
  "user-agent",
  // Passed through unchanged: behind CranL's edge its last entry is the real client, and the API trusts one hop.
  "x-forwarded-for",
];

/** Response headers the browser needs; `set-cookie` is copied separately so several of them survive. */
const RESPONSE_HEADERS = [
  "content-type",
  "cache-control",
  "etag",
  "retry-after",
  "x-request-id",
  "ratelimit-limit",
  "ratelimit-remaining",
  "ratelimit-reset",
];

/**
 * The API's security headers on every answer the forwarder returns, its own errors included; set here rather than
 * passed through, so an upstream answer can neither drop nor weaken them (ADR-700).
 */
export function withSecurityHeaders(headers: Headers): Headers {
  for (const [name, value] of Object.entries(API_SECURITY_HEADERS)) {
    headers.set(name, value);
  }
  return headers;
}

/** Reads at most `limit` bytes of a body; undefined when it is longer. */
export async function readCapped(
  body: ReadableStream<Uint8Array>,
  limit: number,
): Promise<Uint8Array<ArrayBuffer> | undefined> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of body) {
    size += chunk.byteLength;
    if (size > limit) {
      return undefined;
    }
    chunks.push(chunk);
  }
  const whole = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    whole.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return whole;
}

/** The forwarder's own refusals, in the API's envelope and words. */
const REFUSALS = {
  not_found: [404, { ar: "غير موجود.", en: "Not found." }],
  invalid_request: [
    400,
    { ar: "تعذّرت قراءة الطلب. حاول مرة أخرى.", en: "The request could not be read. Try again." },
  ],
  payload_too_large: [413, { ar: "الطلب أكبر من المسموح.", en: "The request is too large." }],
  api_unavailable: [
    502,
    {
      ar: "الخدمة غير متاحة الآن. حاول مرة أخرى بعد قليل.",
      en: "The service is not available right now. Try again shortly.",
    },
  ],
  csrf_rejected: [403, { ar: "الطلب مرفوض.", en: "This request was rejected." }],
  unauthenticated: [401, { ar: "يلزم تسجيل الدخول.", en: "Sign in to continue." }],
  session_expired: [
    401,
    { ar: "انتهت جلستك. سجّل الدخول من جديد.", en: "Your session has ended. Sign in again." },
  ],
} as const satisfies Record<string, readonly [number, LocalizedText]>;

export type Refusal = keyof typeof REFUSALS;

/** A JSON answer of the forwarder's own: no-store, the security headers, and the cookies given. */
export function ownAnswer(
  status: number,
  body: unknown,
  cookies: readonly string[] = [],
  base: Headers = new Headers(),
): Response {
  const headers = withSecurityHeaders(base);
  headers.set("cache-control", "no-store");
  for (const cookie of cookies) {
    headers.append("set-cookie", cookie);
  }
  return body === null
    ? new Response(null, { status, headers })
    : Response.json(body, { status, headers });
}

export function refusal(code: Refusal, cookies: readonly string[] = []): Response {
  const [status, message] = REFUSALS[code];
  return ownAnswer(status, apiError(code, message), cookies);
}

/** The headers sent upstream for one browser request, with the bearer when one is given. */
export function forwardedRequestHeaders(
  incoming: Headers,
  cookie: PlayerCookie,
  bearer?: string,
): Headers {
  const headers = new Headers(appHeaders(incoming));
  for (const name of REQUEST_HEADERS) {
    const value = incoming.get(name);
    if (value !== null) {
      headers.set(name, value);
    }
  }
  if (cookie.others !== undefined) {
    headers.set("cookie", cookie.others);
  }
  if (bearer !== undefined) {
    headers.set("authorization", `Bearer ${bearer}`);
  }
  return headers;
}

/** The upstream answer's headers the browser may see; an upstream `__Host-qs_player` is never passed on. */
export function forwardedResponseHeaders(upstream: Headers): Headers {
  const headers = new Headers();
  for (const name of RESPONSE_HEADERS) {
    const value = upstream.get(name);
    if (value !== null) {
      headers.set(name, value);
    }
  }
  for (const cookie of upstream.getSetCookie()) {
    if (!setsPlayerCookie(cookie)) {
      headers.append("set-cookie", cookie);
    }
  }
  return withSecurityHeaders(headers);
}
