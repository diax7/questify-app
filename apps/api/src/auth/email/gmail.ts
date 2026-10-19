import { createSign, randomUUID } from "node:crypto";
import { EmailSendError, SEND_TIMEOUT_MS, type EmailSender } from "#src/auth/email/sender";

/** The parts of a Google service account key file the sender needs. */
export type ServiceAccountKey = Readonly<{
  clientEmail: string;
  privateKey: string;
  tokenUri: string;
}>;

const SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
const SEND_ENDPOINT = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
/** Tokens last an hour; one is asked for at most this long, and renewed a minute before it runs out. */
const TOKEN_LIFETIME_SECONDS = 3600;
const RENEW_MARGIN_SECONDS = 60;
const HEADER_BREAK = /[\r\n]/;
/** One plain address: no display name, no list, no quotes (an invite will put typed addresses here). */
const ONE_ADDRESS = /^[^\s@<>",;]+@[^\s@<>",;]+\.[a-z]{2,}$/i;
/** Google's reason codes are short identifiers; anything else is not copied into a log line. */
const reasonOf = (value: unknown): string =>
  typeof value === "string" && /^[A-Za-z_]{1,40}$/.test(value) ? value : "unknown";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/**
 * Reads the JSON key file of a Google service account (the `GMAIL_SERVICE_ACCOUNT_KEY` setting).
 *
 * @throws Error naming what is wrong, never echoing the value: not JSON, not a service account key, or a field missing.
 */
export function parseServiceAccountKey(raw: string): ServiceAccountKey {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      "GMAIL_SERVICE_ACCOUNT_KEY is not valid JSON: paste the whole key file, from the first { to the last }.",
    );
  }
  if (!isRecord(parsed) || parsed["type"] !== "service_account") {
    throw new Error(
      'GMAIL_SERVICE_ACCOUNT_KEY is not a service account key (its "type" must be "service_account").',
    );
  }
  const missing = ["client_email", "private_key", "token_uri"].filter(
    (field) => typeof parsed[field] !== "string" || parsed[field] === "",
  );
  if (missing.length > 0) {
    throw new Error(`GMAIL_SERVICE_ACCOUNT_KEY is missing ${missing.join(", ")}.`);
  }
  return {
    clientEmail: String(parsed["client_email"]),
    privateKey: String(parsed["private_key"]),
    tokenUri: String(parsed["token_uri"]),
  };
}

export type GmailOptions = Readonly<{
  key: ServiceAccountKey;
  /** The address the email comes from (`MAIL_FROM`), shown as "Questify <from>". */
  from: string;
  /** The Workspace mailbox the service account acts for; defaults to `from` (set it when `from` is an alias). */
  actAs?: string;
  /** Replaces the real network calls in tests. */
  fetch?: typeof fetch;
  /** Seconds since 1970; replaced in tests. */
  now?: () => number;
}>;

const base64url = (value: string | Buffer): string => Buffer.from(value).toString("base64url");

/** RFC 2047 encoded-word, so an Arabic subject survives every mail server. */
const encodedWord = (text: string): string => `=?UTF-8?B?${Buffer.from(text).toString("base64")}?=`;

/** A plain-text message in UTF-8, base64 in 76-character lines (RFC 2045). */
export function buildMime(input: {
  from: string;
  to: string;
  subject: string;
  text: string;
  date: Date;
}): string {
  for (const [name, value] of [
    ["from", input.from],
    ["to", input.to],
    ["subject", input.subject],
  ] as const) {
    if (HEADER_BREAK.test(value)) {
      throw new EmailSendError("gmail", `the ${name} contains a line break`);
    }
  }
  if (!ONE_ADDRESS.test(input.to)) {
    throw new EmailSendError("gmail", "the to is not one address");
  }
  const domain = input.from.split("@")[1] ?? "questify.invalid";
  const body = Buffer.from(input.text).toString("base64").replace(/.{76}/g, "$&\r\n");
  return [
    `From: Questify <${input.from}>`,
    `To: ${input.to}`,
    `Subject: ${encodedWord(input.subject)}`,
    `Date: ${input.date.toUTCString()}`,
    `Message-ID: <${randomUUID()}@${domain}>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    body,
  ].join("\r\n");
}

type Token = Readonly<{ value: string; expiresAt: number }>;

/**
 * Sends through the Gmail API as a Workspace mailbox, authorised by a service account with domain-wide delegation
 * limited to `gmail.send` (ADR-112). No password exists: the key signs a one-hour token request. Each call is capped
 * at five seconds; errors name the step and Google's error code, never the recipient, the code or the key.
 */
export function createGmailSender(options: GmailOptions): EmailSender {
  const call = options.fetch ?? fetch;
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  let token: Token | undefined;
  let pending: Promise<Token> | undefined;

  const requestToken = async (): Promise<Token> => {
    const issuedAt = now();
    const unsigned = `${base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64url(
      JSON.stringify({
        iss: options.key.clientEmail,
        sub: options.actAs ?? options.from,
        scope: SEND_SCOPE,
        aud: options.key.tokenUri,
        iat: issuedAt,
        exp: issuedAt + TOKEN_LIFETIME_SECONDS,
      }),
    )}`;
    let signature: string;
    try {
      signature = createSign("RSA-SHA256")
        .update(unsigned)
        .sign(options.key.privateKey, "base64url");
    } catch (error) {
      throw new EmailSendError("gmail", "the service account key could not sign", { cause: error });
    }
    let response: Response;
    try {
      response = await call(options.key.tokenUri, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion: `${unsigned}.${signature}`,
        }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
    } catch (error) {
      throw new EmailSendError("gmail", "the token request failed or timed out", { cause: error });
    }
    const body: unknown = await response.json().catch(() => undefined);
    const accessToken = isRecord(body) ? body["access_token"] : undefined;
    if (!response.ok || typeof accessToken !== "string") {
      const code = reasonOf(isRecord(body) ? body["error"] : undefined);
      throw new EmailSendError(
        "gmail",
        `Google refused the token request (${response.status} ${code})`,
      );
    }
    const lifetime =
      isRecord(body) && typeof body["expires_in"] === "number"
        ? body["expires_in"]
        : TOKEN_LIFETIME_SECONDS;
    return { value: accessToken, expiresAt: issuedAt + lifetime - RENEW_MARGIN_SECONDS };
  };

  /** One token at a time, shared by concurrent sends and renewed shortly before it expires. */
  const accessToken = async (): Promise<string> => {
    if (token !== undefined && token.expiresAt > now()) {
      return token.value;
    }
    pending ??= requestToken().finally(() => {
      pending = undefined;
    });
    token = await pending;
    return token.value;
  };

  return {
    name: "gmail",
    send: async (message) => {
      const raw = base64url(
        buildMime({
          from: options.from,
          to: message.to,
          subject: message.subject,
          text: message.text,
          date: new Date(now() * 1000),
        }),
      );
      const bearer = await accessToken();
      let response: Response;
      try {
        response = await call(SEND_ENDPOINT, {
          method: "POST",
          headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
          body: JSON.stringify({ raw }),
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        });
      } catch (error) {
        throw new EmailSendError("gmail", "the send request failed or timed out", { cause: error });
      }
      if (response.status === 401) {
        token = undefined;
      }
      if (!response.ok) {
        const body: unknown = await response.json().catch(() => undefined);
        const error = isRecord(body) && isRecord(body["error"]) ? body["error"] : {};
        throw new EmailSendError(
          "gmail",
          `the Gmail API answered ${response.status} (${reasonOf(error["status"])})`,
        );
      }
    },
  };
}
