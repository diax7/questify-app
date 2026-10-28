import { randomUUID } from "node:crypto";
import { EmailSendError, SEND_TIMEOUT_MS, type EmailSender } from "#src/auth/email/sender";
import {
  createGoogleTokenSource,
  GoogleTokenError,
  reasonOf,
  type ServiceAccountKey,
} from "#src/auth/google-token";

const SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
const SEND_ENDPOINT = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
/** A token is renewed a minute before it runs out. */
const RENEW_MARGIN_SECONDS = 60;
const HEADER_BREAK = /[\r\n]/;
/** One plain address: no display name, no list, no quotes (an invite will put typed addresses here). */
const ONE_ADDRESS = /^[^\s@<>",;]+@[^\s@<>",;]+\.[a-z]{2,}$/i;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

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

/**
 * Sends through the Gmail API as a Workspace mailbox, authorised by a service account with domain-wide delegation
 * limited to `gmail.send` (ADR-112). No password exists: the key signs a one-hour token request (the shared code in
 * `auth/google-token`). Each call is capped at five seconds; errors name the step and Google's error code, never the
 * recipient, the code or the key.
 */
export function createGmailSender(options: GmailOptions): EmailSender {
  const call = options.fetch ?? fetch;
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const tokens = createGoogleTokenSource({
    key: options.key,
    scope: SEND_SCOPE,
    subject: options.actAs ?? options.from,
    timeoutMs: SEND_TIMEOUT_MS,
    renewMarginSeconds: RENEW_MARGIN_SECONDS,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    now,
  });

  /** One token at a time, shared by concurrent sends and renewed shortly before it expires. */
  const accessToken = async (): Promise<string> => {
    try {
      return await tokens.get();
    } catch (error) {
      if (error instanceof GoogleTokenError) {
        throw new EmailSendError("gmail", error.message, { cause: error.cause });
      }
      throw error;
    }
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
        tokens.drop(bearer);
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
