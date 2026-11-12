// A small HTTP client for the demo script: the real API routes, as the dashboard (a staff session cookie, the
// dashboard's Origin) or the player app (a bearer token) call them. It never logs a body, a cookie or a token.
import { randomUUID } from "node:crypto";

const TIMEOUT_MS = 20_000;
const RETRIES = 2;

/** A refused call: the route, the status and the API's error code (never the body's other fields). */
export class ApiError extends Error {
  constructor(method, path, status, code, field) {
    super(
      `${method} ${path} answered ${status}${code ? ` ${code}` : ""}${field ? ` (${field})` : ""}`,
    );
    this.status = status;
    this.code = code;
    this.field = field;
  }
}

/** Waits a little longer each try. */
const pause = (attempt) => new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));

async function send(url, init) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      // Only a network failure is retried; every unsafe call carries an Idempotency-Key, so a retry is safe.
      if (attempt >= RETRIES) {
        throw error;
      }
      await pause(attempt);
    }
  }
}

/** The detail keys an error may show: a field, a reason, a limit or a status; never a code, a token or a person's data. */
const DETAIL_KEYS = ["field", "issue", "reason", "limit", "status"];
/** A short plain word; any other text in a detail is left out. */
const PLAIN = /^[\w.:-]{1,64}$/;
const isPlain = (value) =>
  (typeof value === "string" && PLAIN.test(value)) ||
  typeof value === "number" ||
  typeof value === "boolean";

async function errorOf(method, path, response) {
  const body = await response.json().catch(() => ({}));
  const details = body?.details ?? {};
  const shown = DETAIL_KEYS.filter((key) => isPlain(details[key])).map(
    (key) => `${key}=${details[key]}`,
  );
  const code = isPlain(body?.code) ? body.code : undefined;
  return new ApiError(method, path, response.status, code, shown.join(", ") || undefined);
}

/**
 * A client for one API origin. `origin` is the dashboard's origin (the API's DASHBOARD_ORIGIN), sent on every write so
 * the cookie session's origin check passes, as from the dashboard.
 */
export function createApi({ api, origin }) {
  const base = api.replace(/\/+$/, "");
  /** One call; answers `{ status, body, cookie }` or throws ApiError when the status is not one of `expect`. */
  async function call(
    method,
    path,
    { body, cookie, token, expect = [200, 201], headers = {} } = {},
  ) {
    const unsafe = method !== "GET";
    const response = await send(`${base}${path}`, {
      method,
      headers: {
        accept: "application/json",
        ...(unsafe ? { origin, "idempotency-key": randomUUID() } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(cookie === undefined ? {} : { cookie }),
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!expect.includes(response.status)) {
      throw await errorOf(method, path, response);
    }
    const text = await response.text();
    const setCookie = response.headers.getSetCookie?.() ?? [];
    return {
      status: response.status,
      body: text === "" ? {} : JSON.parse(text),
      cookie: setCookie
        .map((value) => value.split(";")[0])
        .find((pair) => pair.startsWith("__Host-qs_session=")),
    };
  }
  return { call, base, origin };
}
