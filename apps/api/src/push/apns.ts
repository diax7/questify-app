import { createSign } from "node:crypto";
import type { ApnsSettings } from "#src/config";
import { createH2Client, retryAfterMs, type H2Answer } from "#src/push/h2";
import { apnsRequest } from "#src/push/message";
import type { PushMessage, PushProvider, PushResult, PushTarget } from "#src/push/provider";
import type { PushLog } from "#src/push/round";

export type ApnsTarget = Extract<PushTarget, `apns:${string}`>;
export const APNS_TARGETS: readonly ApnsTarget[] = ["apns:production", "apns:sandbox"];

/** Apple's hosts per environment (the device's own, read by the app at registration, ADR-344 (5)). */
export const APNS_ORIGINS: Readonly<Record<ApnsTarget, string>> = {
  "apns:production": "https://api.push.apple.com",
  "apns:sandbox": "https://api.sandbox.push.apple.com",
};

/** The provider token is signed again after this long: Apple wants a new one no more than every 20 minutes, no less than every 60. */
export const APNS_TOKEN_REFRESH_MS = 40 * 60_000;
/** An account refusal holds the target this long (plan, T-501b's APNs table). */
export const APNS_HOLD_MS = 15 * 60_000;
/** One request's own limit, whatever deadline the worker gives. */
export const APNS_REQUEST_MS = 10_000;
/** The most streams in flight on one connection (the worker's wave). */
export const APNS_MAX_STREAMS = 50;
/** A connection with no traffic for this long is closed, so a long quiet spell never writes into a dead socket. */
export const APNS_IDLE_MS = 4 * 60_000;

const REASON = /^[A-Za-z]{1,40}$/;

/** Apple never processed these: a later claim sends them again, on a new connection. */
const NOT_PROCESSED = ["Shutdown", "IdleTimeout"];

/** Account and key refusals: every message on the target would fail the same way, so the target is held. */
const HOLD = [
  "ExpiredProviderToken",
  "InvalidProviderToken",
  "MissingProviderToken",
  "Forbidden",
  "BadEnvironmentKeyIdInToken",
  "UnrelatedKeyIdInToken",
  "BadCertificate",
  "BadCertificateEnvironment",
  "BadTopic",
  "TopicDisallowed",
  "MissingTopic",
  "TooManyProviderTokenUpdates",
];

/**
 * Apple's reasons with an outcome of their own (plan, T-501b's APNs table): `Unregistered` and `ExpiredToken` remove the
 * device; `BadDeviceToken` and `DeviceTokenNotForTopic` too, counted by the mass-invalid guard (plan § Review 4).
 */
const BY_REASON = new Map<string, PushResult>([
  ...["Unregistered", "ExpiredToken"].map(
    (code) => [code, { kind: "invalid_token", code, ambiguous: false }] as const,
  ),
  ...["BadDeviceToken", "DeviceTokenNotForTopic"].map(
    (code) => [code, { kind: "invalid_token", code, ambiguous: true }] as const,
  ),
  ...NOT_PROCESSED.map((code) => [code, { kind: "requeue", code, written: false }] as const),
  ...HOLD.map((code) => [code, { kind: "hold", code, holdMs: APNS_HOLD_MS }] as const),
]);

/** The provider token shared by both APNs targets: the same key signs for production and sandbox. */
export type ApnsToken = Readonly<{
  /** The token to send now, signed again once it is 40 minutes old. */
  current: () => string;
  /** A new token after Apple called `stale` expired; when another request already renewed it, that one. */
  renew: (stale: string) => string;
}>;

const base64url = (value: string): string => Buffer.from(value).toString("base64url");

/** An ES256 JWT (`kid`, `iss`, `iat` in seconds) with the raw r‖s signature JOSE requires. */
function signToken(settings: ApnsSettings, at: number): string {
  const unsigned = `${base64url(JSON.stringify({ alg: "ES256", kid: settings.keyId }))}.${base64url(
    JSON.stringify({ iss: settings.teamId, iat: Math.floor(at / 1000) }),
  )}`;
  const signature = createSign("SHA256")
    .update(unsigned)
    .sign({ key: settings.privateKey, dsaEncoding: "ieee-p1363" }, "base64url");
  return `${unsigned}.${signature}`;
}

/**
 * The APNs provider token (ADR-344 (1)). It is signed once here, so a key that cannot sign stops the server at start
 * (the startup check), then again every 40 minutes and once after `ExpiredProviderToken`.
 *
 * @throws Error naming `APNS_PRIVATE_KEY` (never the key) when the key cannot sign.
 */
export function createApnsToken(settings: ApnsSettings, now: () => number = Date.now): ApnsToken {
  const fresh = (): Readonly<{ value: string; at: number }> => {
    const at = now();
    try {
      return { value: signToken(settings, at), at };
    } catch (error) {
      throw new Error("APNS_PRIVATE_KEY could not sign the APNs provider token.", {
        cause: error,
      });
    }
  };
  let token = fresh();
  return {
    current: () => {
      if (now() - token.at >= APNS_TOKEN_REFRESH_MS) token = fresh();
      return token.value;
    },
    renew: (stale) => {
      if (stale === token.value) token = fresh();
      return token.value;
    },
  };
}

/** Apple's `reason`, when the body carries one that is a plain word. */
export function apnsReason(answer: H2Answer): string | null {
  if (answer.kind !== "answer") return null;
  try {
    const reason: unknown = (JSON.parse(answer.body) as { reason?: unknown } | null)?.reason;
    return typeof reason === "string" && REASON.test(reason) ? reason : null;
  } catch {
    return null;
  }
}

/** A refusal whose reason has no outcome of its own, by its status: 410 removes, 403 holds, 5xx is tried again. */
function byStatus(status: number, code: string, retryAfter: number | undefined): PushResult {
  if (status === 410) return { kind: "invalid_token", code, ambiguous: false };
  if (status === 403) return { kind: "hold", code, holdMs: APNS_HOLD_MS };
  if (status >= 500) {
    return retryAfter === undefined
      ? { kind: "requeue", code, written: true }
      : { kind: "requeue", code, written: true, retryAfterMs: retryAfter };
  }
  return { kind: "failed", code };
}

/** What one APNs exchange came to, as the worker's outcome. */
export function apnsResult(answer: H2Answer, now: number = Date.now()): PushResult {
  if (answer.kind === "not_sent") return { kind: "requeue", code: answer.code, written: false };
  if (answer.kind === "lost") return { kind: "unknown", code: answer.code };
  if (answer.status === 200) return { kind: "sent" };
  const reason = apnsReason(answer);
  const known = reason === null ? undefined : BY_REASON.get(reason);
  return (
    known ??
    byStatus(
      answer.status,
      reason ?? `http_${answer.status}`,
      retryAfterMs(answer.headers["retry-after"], now),
    )
  );
}

/** The connection is replaced after a hold (a key Apple ties to the connection) and after Apple said it processed nothing. */
const replacesConnection = (answer: H2Answer, result: PushResult): boolean =>
  result.kind === "hold" || NOT_PROCESSED.includes(apnsReason(answer) ?? "");

/** A refusal that is our own bug (a 4xx but a device's 429) as log fields: the status and Apple's code only. */
function ourBug(answer: H2Answer, result: PushResult): Record<string, unknown> | null {
  if (result.kind !== "failed" || answer.kind !== "answer" || answer.status === 429) return null;
  return { status: answer.status, code: result.code };
}

export type ApnsOptions = Readonly<{
  target: ApnsTarget;
  token: ApnsToken;
  /** The app's bundle id (`apns-topic`). */
  topic: string;
  log: PushLog;
  /** Replaces Apple's host (a local HTTP/2 server in tests). */
  origin?: string;
}>;

/**
 * The APNs client for one environment (ADR-344, plan T-501b): one HTTP/2 connection reused for every send, the shared
 * provider token, Apple's headers from `apnsRequest`, and each answer mapped to the worker's outcome. A send gives up
 * by its deadline (at most 10 s), answering `requeue` (not written) when the request never left. `ExpiredProviderToken`
 * re-signs once and sends again; a second one holds the target. A refusal that is our own bug is logged at error level
 * with the status and Apple's reason only; nothing here logs a token, a key or the text.
 */
export function createApnsProvider(options: ApnsOptions): PushProvider {
  const client = createH2Client({
    origin: options.origin ?? APNS_ORIGINS[options.target],
    maxStreams: APNS_MAX_STREAMS,
    idleMs: APNS_IDLE_MS,
  });
  const post = (message: PushMessage, bearer: string, until: number): Promise<H2Answer> => {
    const request = apnsRequest(message, options.topic);
    return client.post(
      {
        path: `/3/device/${encodeURIComponent(message.token)}`,
        headers: { ...request.headers, authorization: `bearer ${bearer}` },
        body: request.body,
      },
      until,
    );
  };
  const exchange = async (message: PushMessage, until: number): Promise<H2Answer> => {
    const bearer = options.token.current();
    const answer = await post(message, bearer, until);
    return apnsReason(answer) === "ExpiredProviderToken"
      ? post(message, options.token.renew(bearer), until)
      : answer;
  };
  return {
    target: options.target,
    send: async (message, deadline) => {
      const until = Math.min(deadline.getTime(), Date.now() + APNS_REQUEST_MS);
      const answer = await exchange(message, until);
      const result = apnsResult(answer);
      if (replacesConnection(answer, result)) client.reconnect();
      const bug = ourBug(answer, result);
      if (bug !== null) {
        options.log("error", { event: "push.apns_refused", target: options.target, ...bug });
      }
      return result;
    },
    close: client.close,
  };
}
