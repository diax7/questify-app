import { createSign, type KeyObject } from "node:crypto";

/** The parts of a Google service account key file a token request needs. */
export type ServiceAccountKey = Readonly<{
  clientEmail: string;
  /** The account's RSA key: its PEM, or the key already parsed (never printed by a log or an inspect). */
  privateKey: string | KeyObject;
  tokenUri: string;
}>;

/** Tokens last an hour; one is asked for at most this long. */
const TOKEN_LIFETIME_SECONDS = 3600;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** Google's reason codes are short identifiers; anything else is not copied into a message or a log line. */
export const reasonOf = (value: unknown): string =>
  typeof value === "string" && /^[A-Za-z_]{1,40}$/.test(value) ? value : "unknown";

/**
 * Reads the named string fields of a Google service account key file (JSON) given in the setting `setting`.
 *
 * @throws Error naming the setting and what is wrong, never echoing the value: not JSON, not a service account key, or a
 *   field missing or empty.
 */
export function readServiceAccount<F extends string>(
  raw: string,
  setting: string,
  fields: readonly F[],
): Readonly<Record<F, string>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `${setting} is not valid JSON: paste the whole key file, from the first { to the last }.`,
    );
  }
  if (!isRecord(parsed) || parsed["type"] !== "service_account") {
    throw new Error(
      `${setting} is not a service account key (its "type" must be "service_account").`,
    );
  }
  const missing = fields.filter(
    (field) => typeof parsed[field] !== "string" || parsed[field] === "",
  );
  if (missing.length > 0) {
    throw new Error(`${setting} is missing ${missing.join(", ")}.`);
  }
  return Object.fromEntries(fields.map((field) => [field, String(parsed[field])])) as Record<
    F,
    string
  >;
}

/** The three fields every token request needs, from the key file in `setting`. */
export function parseServiceAccountKey(raw: string, setting: string): ServiceAccountKey {
  const fields = readServiceAccount(raw, setting, ["client_email", "private_key", "token_uri"]);
  return {
    clientEmail: fields.client_email,
    privateKey: fields.private_key,
    tokenUri: fields.token_uri,
  };
}

/**
 * Why a token could not be had: the key would not sign, Google could not be reached or answer (a network failure, a
 * timeout, a 5xx or a 429: worth asking again), or Google refused the account.
 */
export type GoogleTokenFailure = "sign" | "unreachable" | "refused";

/** A token request failed. The message names the step and Google's code, never the key or the token. */
export class GoogleTokenError extends Error {
  readonly failure: GoogleTokenFailure;
  /** Google's HTTP status, when it answered. */
  readonly status: number | undefined;
  /** Google's reason code (`invalid_grant`), or `unknown`. */
  readonly code: string;

  constructor(
    failure: GoogleTokenFailure,
    reason: string,
    details: Readonly<{ status?: number; code?: string; cause?: unknown }> = {},
  ) {
    super(reason, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = "GoogleTokenError";
    this.failure = failure;
    this.status = details.status;
    this.code = details.code ?? "unknown";
  }
}

export type GoogleTokenOptions = Readonly<{
  key: ServiceAccountKey;
  scope: string;
  /** The mailbox the service account acts for (domain-wide delegation, Gmail); none for FCM. */
  subject?: string;
  /** Each token request is cut off after this long. */
  timeoutMs: number;
  /** A token is renewed this many seconds before Google says it ends. */
  renewMarginSeconds: number;
  /** Replaces the real network call in tests. */
  fetch?: typeof fetch;
  /** Seconds since 1970; replaced in tests. */
  now?: () => number;
}>;

export type GoogleTokenSource = Readonly<{
  /**
   * A live access token: the cached one, or one asked for now and shared by every caller waiting at the same time.
   *
   * @throws GoogleTokenError when the key cannot sign, Google cannot be reached, or Google refuses.
   */
  get: () => Promise<string>;
  /** Forgets `token` after Google refused it (a 401), so the next `get` asks again; a newer token is kept. */
  drop: (token: string) => void;
}>;

type Token = Readonly<{ value: string; expiresAt: number }>;

const base64url = (value: string): string => Buffer.from(value).toString("base64url");

/** The signed JWT assertion a service account trades for an access token (RFC 7523). */
function assertion(options: GoogleTokenOptions, issuedAt: number): string {
  const unsigned = `${base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64url(
    JSON.stringify({
      iss: options.key.clientEmail,
      ...(options.subject === undefined ? {} : { sub: options.subject }),
      scope: options.scope,
      aud: options.key.tokenUri,
      iat: issuedAt,
      exp: issuedAt + TOKEN_LIFETIME_SECONDS,
    }),
  )}`;
  try {
    return `${unsigned}.${createSign("RSA-SHA256").update(unsigned).sign(options.key.privateKey, "base64url")}`;
  } catch (error) {
    throw new GoogleTokenError("sign", "the service account key could not sign", { cause: error });
  }
}

/** Google's answer without a token: a 5xx or a 429 is Google not answering (ask again), anything else a refusal. */
function tokenRefusal(status: number, body: unknown): GoogleTokenError {
  const code = reasonOf(isRecord(body) ? body["error"] : undefined);
  const details = { status, code };
  return status >= 500 || status === 429
    ? new GoogleTokenError(
        "unreachable",
        `Google could not answer the token request (${status} ${code})`,
        details,
      )
    : new GoogleTokenError(
        "refused",
        `Google refused the token request (${status} ${code})`,
        details,
      );
}

/** Asks Google for one access token with a fresh assertion. */
async function requestToken(options: GoogleTokenOptions, issuedAt: number): Promise<Token> {
  const signed = assertion(options, issuedAt);
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(options.key.tokenUri, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: signed,
      }),
      signal: AbortSignal.timeout(options.timeoutMs),
    });
  } catch (error) {
    throw new GoogleTokenError("unreachable", "the token request failed or timed out", {
      cause: error,
    });
  }
  const body: unknown = await response.json().catch(() => undefined);
  const accessToken = isRecord(body) ? body["access_token"] : undefined;
  if (!response.ok || typeof accessToken !== "string") {
    throw tokenRefusal(response.status, body);
  }
  const lifetime =
    isRecord(body) && typeof body["expires_in"] === "number"
      ? body["expires_in"]
      : TOKEN_LIFETIME_SECONDS;
  return { value: accessToken, expiresAt: issuedAt + lifetime - options.renewMarginSeconds };
}

/**
 * Access tokens for a Google service account (ADR-112, ADR-344): the key signs a one-hour assertion, Google answers a
 * token, and the token is kept until `renewMarginSeconds` before it ends. One request at a time, shared by every caller
 * waiting together; a failed request is not cached, so the next caller asks again.
 */
export function createGoogleTokenSource(options: GoogleTokenOptions): GoogleTokenSource {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  let token: Token | undefined;
  let pending: Promise<Token> | undefined;
  return {
    get: async () => {
      if (token !== undefined && token.expiresAt > now()) {
        return token.value;
      }
      pending ??= requestToken(options, now()).finally(() => {
        pending = undefined;
      });
      token = await pending;
      return token.value;
    },
    drop: (stale) => {
      if (token?.value === stale) {
        token = undefined;
      }
    },
  };
}
