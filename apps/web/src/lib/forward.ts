import { API_SECURITY_HEADERS, apiError, type ApiErrorEnvelope } from "@questify/shared";
import type { HostKind } from "#src/lib/console-host.ts";

/** Request headers the API needs; everything else (host, the client's own `x-*`) is dropped. */
const REQUEST_HEADERS = [
  "content-type",
  "cookie",
  "origin",
  "idempotency-key",
  "if-none-match",
  "accept-language",
  "user-agent",
  // Who started the request, by the browser's own account: the API refuses a staff request from the other host on it
  // before any session lookup (T-810d).
  "sec-fetch-site",
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

/** Encoded dots, slashes and backslashes could walk a decoded path out of `/v1`. */
const ENCODED_PATH_TRICK = /%2e|%2f|%5c/i;

export type ForwardOptions = Readonly<{
  apiOrigin: string;
  /** The host the request reached (`hostKind`): the public host never forwards `/v1/admin/*` (T-810d, ADR-722). */
  host: HostKind;
  timeoutMs: number;
  maxBodyBytes: number;
  /** Receives only the method, path and reason of a failure: never a body, a cookie or a query. */
  log: (fields: Readonly<Record<string, string>>) => void;
  fetchImpl?: typeof fetch;
}>;

/**
 * The API's security headers on every answer the forwarder returns, its own errors included; set here rather than
 * passed through, so an upstream answer can neither drop nor weaken them (ADR-700).
 */
function withSecurityHeaders(headers: Headers): Headers {
  for (const [name, value] of Object.entries(API_SECURITY_HEADERS)) {
    headers.set(name, value);
  }
  return headers;
}

function errorResponse(status: number, envelope: ApiErrorEnvelope): Response {
  return Response.json(envelope, {
    status,
    headers: withSecurityHeaders(new Headers({ "cache-control": "no-store" })),
  });
}

const notFound = () =>
  errorResponse(404, apiError("not_found", { ar: "غير موجود.", en: "Not found." }));

/** Reads at most `limit` bytes of a body; undefined when it is longer. */
async function readCapped(
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

function forwardedRequestHeaders(incoming: Headers): Headers {
  const headers = new Headers();
  for (const name of REQUEST_HEADERS) {
    const value = incoming.get(name);
    if (value !== null) {
      headers.set(name, value);
    }
  }
  return headers;
}

function forwardedResponseHeaders(upstream: Headers): Headers {
  const headers = new Headers();
  for (const name of RESPONSE_HEADERS) {
    const value = upstream.get(name);
    if (value !== null) {
      headers.set(name, value);
    }
  }
  for (const cookie of upstream.getSetCookie()) {
    headers.append("set-cookie", cookie);
  }
  return withSecurityHeaders(headers);
}

const CONSOLE_API = "/v1/admin/";

/**
 * The API address for this request, or undefined when the path is not a plain `/v1/...` path, or is a console path on
 * the public host.
 */
function targetOf(request: Request, apiOrigin: string, host: HostKind): URL | undefined {
  const incoming = new URL(request.url);
  if (!incoming.pathname.startsWith("/v1/") || ENCODED_PATH_TRICK.test(incoming.pathname)) {
    return undefined;
  }
  if (host === "public" && incoming.pathname.startsWith(CONSOLE_API)) {
    return undefined;
  }
  const target = new URL(incoming.pathname + incoming.search, apiOrigin);
  return target.origin === new URL(apiOrigin).origin && target.pathname.startsWith("/v1/")
    ? target
    : undefined;
}

/**
 * Forwards one browser request to the API (same origin for the browser, so the `__Host-` session cookie and
 * `SameSite=Strict` work without CORS). Never retries: sign-in steps are not safe to repeat.
 */
export async function forward(request: Request, options: ForwardOptions): Promise<Response> {
  const target = targetOf(request, options.apiOrigin, options.host);
  if (target === undefined) {
    return notFound();
  }
  let body: Uint8Array<ArrayBuffer> | undefined;
  if (request.body !== null && request.method !== "GET" && request.method !== "HEAD") {
    try {
      body = await readCapped(request.body, options.maxBodyBytes);
    } catch {
      options.log({
        event: "api_forward_failed",
        method: request.method,
        path: target.pathname,
        reason: "body_unreadable",
      });
      return errorResponse(
        400,
        apiError("invalid_request", {
          ar: "تعذّرت قراءة الطلب. حاول مرة أخرى.",
          en: "The request could not be read. Try again.",
        }),
      );
    }
    if (body === undefined) {
      return errorResponse(
        413,
        apiError("payload_too_large", {
          ar: "الطلب أكبر من المسموح.",
          en: "The request is too large.",
        }),
      );
    }
  }
  try {
    const upstream = await (options.fetchImpl ?? fetch)(target, {
      method: request.method,
      headers: forwardedRequestHeaders(request.headers),
      ...(body === undefined ? {} : { body }),
      redirect: "manual",
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    const empty = upstream.status === 204 || upstream.status === 304 || request.method === "HEAD";
    return new Response(empty ? null : upstream.body, {
      status: upstream.status,
      headers: forwardedResponseHeaders(upstream.headers),
    });
  } catch (error) {
    const reason =
      error instanceof Error && error.name === "TimeoutError" ? "timeout" : "unreachable";
    options.log({
      event: "api_forward_failed",
      method: request.method,
      path: target.pathname,
      reason,
    });
    return errorResponse(
      502,
      apiError("api_unavailable", {
        ar: "الخدمة غير متاحة الآن. حاول مرة أخرى بعد قليل.",
        en: "The service is not available right now. Try again shortly.",
      }),
    );
  }
}
