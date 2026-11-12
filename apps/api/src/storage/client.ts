import { createHash } from "node:crypto";
import { AwsV4Signer } from "aws4fetch";
import type { StorageSettings } from "#src/storage/config";

/** The bucket's three operations the API needs (ADR-183): put a re-encoded JPEG, delete it, sign a short read. */
export type ObjectStore = Readonly<{
  put: (key: string, body: Buffer) => Promise<void>;
  /** A delete of an object that is already gone (404) is done. */
  delete: (key: string) => Promise<void>;
  /** A GET URL on the bucket's host that works for `ttlSeconds` (at most 300). */
  signGet: (key: string, ttlSeconds: number) => Promise<SignedUrl>;
}>;

export type SignedUrl = Readonly<{ url: string; expiresAt: Date }>;

type Op = "put" | "delete";

/** A call the bucket did not complete: its answer (`status`), no answer in time (`timeout`) or no connection. */
export class StorageError extends Error {
  readonly op: Op;
  readonly code: "status" | "timeout" | "network";
  readonly status: number | null;

  constructor(op: Op, code: StorageError["code"], status: number | null) {
    super(`storage ${op} failed: ${code}${status === null ? "" : ` ${status}`}`);
    this.name = "StorageError";
    this.op = op;
    this.code = code;
    this.status = status;
  }
}

export type StoreOptions = Readonly<{
  fetch?: typeof fetch;
  /** Each attempt's own limit (10 s). */
  timeoutMs?: number;
  /** The base of the back-off between attempts (200 ms, times the attempt, with jitter). */
  retryDelayMs?: number;
  random?: () => number;
  now?: () => Date;
  /** One line per failed call: its operation, the key's purpose and the last status. Never a key or a URL. */
  log?: (fields: Readonly<Record<string, unknown>>) => void;
}>;

const ATTEMPTS = 3;
export const MAX_SIGNED_SECONDS = 300;
const PURPOSE = /^o\/[^/]+\/e\/[^/]+\/([a-z_]+)\//;

const purposeOf = (key: string): string => PURPOSE.exec(key)?.[1] ?? "unknown";
const retryable = (status: number): boolean => status >= 500 || status === 429;
const amzDate = (at: Date): string => at.toISOString().replace(/[:-]|\.\d{3}/g, "");

function objectUrl(settings: StorageSettings, key: string): URL {
  const path = key.split("/").map(encodeURIComponent).join("/");
  const base = new URL(settings.endpoint);
  if (settings.urlStyle === "virtual") {
    return new URL(`${base.protocol}//${settings.bucket}.${base.host}/${path}`);
  }
  return new URL(`${base.origin}/${settings.bucket}/${path}`);
}

type Attempt = Readonly<{ status: number } | { error: "timeout" | "network" }>;

/** The error of a call that never got the answer it wanted, logged by its operation, purpose and status only. */
function failure(op: Op, key: string, last: Attempt, log: StoreOptions["log"]): StorageError {
  const status = "status" in last ? last.status : null;
  log?.({ event: "storage.failed", op, purpose: purposeOf(key), status });
  return new StorageError(op, "status" in last ? "status" : last.error, status);
}

/** An attempt's outcome: what the call wanted, an answer no retry changes (403 and the like), or worth one more try. */
const verdictOf = (
  last: Attempt,
  done: (status: number) => boolean,
): "done" | "final" | "again" => {
  if (!("status" in last)) return "again";
  if (done(last.status)) return "done";
  return retryable(last.status) ? "again" : "final";
};

/**
 * The S3 client on aws4fetch's signer, path-style by default. Every call has its own timeout and is tried at most three
 * times: again after a network error, a timeout, 5xx or 429 (PUT and DELETE of one key are safe to repeat), never after
 * another answer such as 403. Redirects are refused (ADR-701).
 */
export function createObjectStore(
  settings: StorageSettings,
  options: StoreOptions = {},
): ObjectStore {
  const call = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const delayMs = options.retryDelayMs ?? 200;
  const random = options.random ?? Math.random;
  const now = options.now ?? (() => new Date());
  const credentials = {
    accessKeyId: settings.accessKeyId,
    secretAccessKey: settings.secretAccessKey,
    service: "s3",
    region: settings.region,
  };

  const attempt = async (
    method: string,
    key: string,
    body: Buffer | undefined,
  ): Promise<Attempt> => {
    const headers: Record<string, string> =
      body === undefined
        ? {}
        : {
            "content-type": "image/jpeg",
            "x-amz-content-sha256": createHash("sha256").update(body).digest("hex"),
          };
    const signed = await new AwsV4Signer({
      ...credentials,
      method,
      url: objectUrl(settings, key).toString(),
      headers,
      datetime: amzDate(now()),
    }).sign();
    try {
      const response = await call(signed.url, {
        method,
        headers: signed.headers,
        ...(body === undefined ? {} : { body: new Uint8Array(body) }),
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
      await response.body?.cancel();
      return { status: response.status };
    } catch (error) {
      const name = (error as { name?: string } | undefined)?.name;
      return { error: name === "TimeoutError" || name === "AbortError" ? "timeout" : "network" };
    }
  };

  const send = async (
    op: Op,
    key: string,
    body: Buffer | undefined,
    done: (status: number) => boolean,
  ) => {
    let last: Attempt = { error: "network" };
    for (let tried = 1; tried <= ATTEMPTS; tried += 1) {
      last = await attempt(op === "put" ? "PUT" : "DELETE", key, body);
      const verdict = verdictOf(last, done);
      if (verdict === "done") return;
      if (verdict === "final" || tried === ATTEMPTS) break;
      await new Promise((resolve) => setTimeout(resolve, delayMs * tried * (0.5 + random())));
    }
    throw failure(op, key, last, options.log);
  };

  return {
    put: (key, body) => send("put", key, body, (status) => status === 200),
    delete: (key) =>
      send(
        "delete",
        key,
        undefined,
        (status) => status === 204 || status === 200 || status === 404,
      ),
    signGet: async (key, ttlSeconds) => {
      if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > MAX_SIGNED_SECONDS) {
        throw new RangeError(`A signed read lasts 1 to at most ${MAX_SIGNED_SECONDS} seconds.`);
      }
      const at = now();
      const url = objectUrl(settings, key);
      url.searchParams.set("X-Amz-Expires", String(ttlSeconds));
      url.searchParams.set("response-content-type", "image/jpeg");
      url.searchParams.set("response-content-disposition", "inline");
      const signed = await new AwsV4Signer({
        ...credentials,
        method: "GET",
        url: url.toString(),
        signQuery: true,
        datetime: amzDate(at),
      }).sign();
      return {
        url: signed.url.toString(),
        expiresAt: new Date(Math.floor(at.getTime() / 1000) * 1000 + ttlSeconds * 1000),
      };
    },
  };
}
