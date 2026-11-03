// The one door to the CranL REST API for the infrastructure script (T-017, ADR-650). Every call has a timeout; reads
// are retried on a network error, 429 or 5xx; writes carry an idempotency key, so the same retry is safe. The API key
// is never printed, and an error names the method and the path, never a request or response body.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const BASE_URL = "https://app.cranl.com/api/v1";
const TIMEOUT_MS = 30_000;
const ATTEMPTS = 3;
const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504]);

export class CranlError extends Error {
  /**
   * @param {string} message
   * @param {number} status
   * @param {string | undefined} code
   */
  constructor(message, status, code) {
    super(message);
    this.name = "CranlError";
    this.status = status;
    this.code = code;
  }
}

/** Reads the API key from CRANL_API_KEY, else from the CranL CLI's ~/.cranl/config.json. */
export function readApiKey(env = process.env) {
  if (env.CRANL_API_KEY) return env.CRANL_API_KEY;
  const file = join(homedir(), ".cranl", "config.json");
  try {
    const key = JSON.parse(readFileSync(file, "utf8")).api_key;
    if (typeof key === "string" && key.length > 0) return key;
  } catch {
    // Falls through to the error below, which says where the key is looked for.
  }
  throw new Error(
    `No CranL API key: set CRANL_API_KEY or sign in with the CranL CLI (it writes ${file}).`,
  );
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function readBody(response) {
  const text = await response.text();
  if (text === "") return {};
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Makes a client bound to one API key.
 *
 * @param {{ apiKey: string, fetch?: typeof fetch, baseUrl?: string, retryDelayMs?: number }} options
 */
export function createClient({
  apiKey,
  fetch: doFetch = fetch,
  baseUrl = BASE_URL,
  retryDelayMs = 1000,
}) {
  async function once(method, path, body) {
    const response = await doFetch(baseUrl + path, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return { status: response.status, body: await readBody(response) };
  }

  async function call(method, path, body) {
    let last;
    for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
      try {
        last = await once(method, path, body);
        if (!RETRY_STATUS.has(last.status)) break;
      } catch (error) {
        last = { status: 0, body: {}, cause: error };
      }
      if (attempt < ATTEMPTS) await wait(retryDelayMs * attempt);
    }
    if (last.status >= 200 && last.status < 300) {
      if (last.body !== null) return last.body;
      throw new CranlError(
        `CranL ${method} ${path} answered ${last.status} without JSON`,
        last.status,
      );
    }
    const code = last.body?.error?.code;
    const reason = last.status === 0 ? `no answer (${last.cause?.name ?? "error"})` : last.status;
    throw new CranlError(
      `CranL ${method} ${path} failed: ${reason}${code ? ` ${code}` : ""}`,
      last.status,
      code,
    );
  }

  return {
    get: (path) => call("GET", path),
    /** A write; `key` makes a retry return the first result instead of acting twice. */
    send: (method, path, body, key) => call(method, path, { ...body, idempotency_key: key }),
  };
}
