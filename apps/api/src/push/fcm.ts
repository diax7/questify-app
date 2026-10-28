import {
  createGoogleTokenSource,
  GoogleTokenError,
  type GoogleTokenSource,
} from "#src/auth/google-token";
import type { FcmSettings } from "#src/config";
import { createH2Client, retryAfterMs, type H2Answer } from "#src/push/h2";
import { fcmRequest } from "#src/push/message";
import type { PushMessage, PushProvider, PushResult } from "#src/push/provider";
import type { PushLog } from "#src/push/round";

export const FCM_ORIGIN = "https://fcm.googleapis.com";
/** The OAuth scope that lets a service account send through FCM HTTP v1. */
export const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
/** An account refusal (or a token Google keeps refusing) holds `fcm` this long (plan, T-501b's FCM table). */
export const FCM_HOLD_MS = 15 * 60_000;
/** A quota refusal holds `fcm` for Google's Retry-After, and never less than this (Google: back off at least a minute). */
export const FCM_QUOTA_HOLD_MS = 60_000;
/** One request's own limit, and one token request's. */
export const FCM_REQUEST_MS = 10_000;
/** An access token is renewed this many seconds before it ends. */
export const FCM_TOKEN_MARGIN_SECONDS = 300;
export const FCM_MAX_STREAMS = 50;
export const FCM_IDLE_MS = 4 * 60_000;

const ERROR_CODE = /^[A-Z_]{1,40}$/;
const FCM_ERROR_TYPE = "type.googleapis.com/google.firebase.fcm.v1.FcmError";
const BAD_REQUEST_TYPE = "type.googleapis.com/google.rpc.BadRequest";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** What an FCM error body says: FCM's own code, Google's status, and whether it names the registration token. */
export type FcmError = Readonly<{
  errorCode: string | null;
  status: string | null;
  tokenNamed: boolean;
}>;

const plainCode = (value: unknown): string | null =>
  typeof value === "string" && ERROR_CODE.test(value) ? value : null;

/** Whether one `details` entry names the token: a `BadRequest` field violation on `message.token`. */
const namesToken = (detail: Record<string, unknown>): boolean =>
  detail["@type"] === BAD_REQUEST_TYPE &&
  Array.isArray(detail["fieldViolations"]) &&
  detail["fieldViolations"].some(
    (violation) => isRecord(violation) && violation["field"] === "message.token",
  );

/** Reads an FCM v1 error body; nothing of it is kept but codes. */
export function fcmError(body: string): FcmError {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { errorCode: null, status: null, tokenNamed: false };
  }
  const error = isRecord(parsed) && isRecord(parsed["error"]) ? parsed["error"] : {};
  const details = (Array.isArray(error["details"]) ? error["details"] : []).filter(isRecord);
  const fcm = details.find((detail) => detail["@type"] === FCM_ERROR_TYPE);
  const message = typeof error["message"] === "string" ? error["message"] : "";
  return {
    errorCode: plainCode(fcm?.["errorCode"]),
    status: plainCode(error["status"]),
    tokenNamed: details.some(namesToken) || message.includes("not a valid FCM registration token"),
  };
}

/** A refusal by FCM's own code first (plan, T-501b's FCM table). */
function byErrorCode(status: number, error: FcmError, code: string): PushResult | null {
  if (error.errorCode === "UNREGISTERED") return { kind: "invalid_token", code, ambiguous: false };
  if (error.errorCode === "SENDER_ID_MISMATCH") {
    return { kind: "invalid_token", code, ambiguous: true };
  }
  if (status === 400 && error.tokenNamed) return { kind: "invalid_token", code, ambiguous: true };
  return null;
}

/** A refusal by its status: 401 and 403 hold, 429 holds for Retry-After (at least a minute), 5xx is tried again. */
function byStatus(status: number, code: string, retryAfter: number | undefined): PushResult {
  if (status === 401 || status === 403) return { kind: "hold", code, holdMs: FCM_HOLD_MS };
  if (status === 429) {
    return { kind: "hold", code, holdMs: Math.max(retryAfter ?? 0, FCM_QUOTA_HOLD_MS) };
  }
  if (status >= 500) {
    return retryAfter === undefined
      ? { kind: "requeue", code, written: true }
      : { kind: "requeue", code, written: true, retryAfterMs: retryAfter };
  }
  return { kind: "failed", code };
}

/** What one FCM exchange came to, as the worker's outcome. */
export function fcmResult(answer: H2Answer, now: number = Date.now()): PushResult {
  if (answer.kind === "not_sent") return { kind: "requeue", code: answer.code, written: false };
  if (answer.kind === "lost") return { kind: "unknown", code: answer.code };
  if (answer.status === 200) return { kind: "sent" };
  const error = fcmError(answer.body);
  const code = error.errorCode ?? error.status ?? `http_${answer.status}`;
  return (
    byErrorCode(answer.status, error, code) ??
    byStatus(answer.status, code, retryAfterMs(answer.headers["retry-after"], now))
  );
}

export type FcmOptions = Readonly<{
  settings: FcmSettings;
  log: PushLog;
  /** Replaces Google's host (a local HTTP/2 server in tests). */
  origin?: string;
  /** Replaces the token request's network call in tests. */
  fetch?: typeof fetch;
  /** Wall-clock milliseconds; replaced in tests. */
  now?: () => number;
}>;

/** A bearer for this send, or the result to answer when none can be had by `until`. */
type Bearer = Readonly<{ value: string }> | PushResult;

const H2_KINDS = new Set<string>(["answer", "not_sent", "lost"]);
const isH2Answer = (value: H2Answer | PushResult): value is H2Answer => H2_KINDS.has(value.kind);

/** The access token, or what to answer when it cannot be had: `failed` maps a token error, the deadline requeues. */
async function bearerBy(
  tokens: GoogleTokenSource,
  until: number,
  failed: (error: unknown) => PushResult,
): Promise<Bearer> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<PushResult>((resolve) => {
    timer = setTimeout(
      () => resolve({ kind: "requeue", code: "token_timeout", written: false }),
      Math.max(0, until - Date.now()),
    );
  });
  const asked = tokens.get().then((value): Bearer => ({ value }), failed);
  return Promise.race([asked, late]).finally(() => clearTimeout(timer));
}

/** Google's code for a refused answer: FCM's own, else Google's status, else the HTTP status. */
function refusedCode(answer: H2Answer & { kind: "answer" }): string {
  const error = fcmError(answer.body);
  return error.errorCode ?? error.status ?? `http_${answer.status}`;
}

/**
 * The FCM HTTP v1 client (ADR-344, plan T-501b): `messages:send` on the Firebase project over one reused HTTP/2
 * connection, with an access token from the service account (scope `firebase.messaging`), cached until 5 minutes before
 * it ends and asked for again once after a 401. The first token is asked for at start in the background (the startup
 * check): a refusal logs `push.fcm_auth_failed` and holds `fcm` for 15 minutes, every send answering `hold` until then;
 * an unreachable Google is logged the same way and the next send asks again. A send gives up by its deadline (at most
 * 10 s). Nothing here logs a token, a key or the text.
 */
export function createFcmProvider(options: FcmOptions): PushProvider {
  const now = options.now ?? Date.now;
  const tokens = createGoogleTokenSource({
    key: options.settings.key,
    scope: FCM_SCOPE,
    timeoutMs: FCM_REQUEST_MS,
    renewMarginSeconds: FCM_TOKEN_MARGIN_SECONDS,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    now: () => Math.floor(now() / 1000),
  });
  const client = createH2Client({
    origin: options.origin ?? FCM_ORIGIN,
    maxStreams: FCM_MAX_STREAMS,
    idleMs: FCM_IDLE_MS,
  });
  let heldUntil = 0;

  /** Google refused the account: one alert per hold, and every send holds until it ends. */
  const refused = (status: number | null, code: string): PushResult => {
    if (heldUntil <= now()) {
      options.log("error", { event: "push.fcm_auth_failed", status, code });
    }
    heldUntil = now() + FCM_HOLD_MS;
    return { kind: "hold", code: "fcm_auth", holdMs: FCM_HOLD_MS };
  };

  const tokenFailed = (error: unknown): PushResult =>
    error instanceof GoogleTokenError && error.failure !== "unreachable"
      ? refused(error.status ?? null, error.code)
      : { kind: "requeue", code: "token_unreachable", written: false };

  const post = (message: PushMessage, token: string, until: number): Promise<H2Answer> =>
    client.post(
      {
        path: `/v1/projects/${options.settings.projectId}/messages:send`,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: fcmRequest(message, new Date(now())),
      },
      until,
    );

  /** One send, and once more with a new token when Google answered 401 to the first. */
  const exchange = async (message: PushMessage, until: number): Promise<H2Answer | PushResult> => {
    const first = await bearerBy(tokens, until, tokenFailed);
    if (!("value" in first)) return first;
    const answer = await post(message, first.value, until);
    if (answer.kind !== "answer" || answer.status !== 401) return answer;
    tokens.drop(first.value);
    const second = await bearerBy(tokens, until, tokenFailed);
    if (!("value" in second)) return second;
    const again = await post(message, second.value, until);
    return again.kind === "answer" && again.status === 401
      ? refused(401, refusedCode(again))
      : again;
  };

  void tokens.get().catch((error: unknown) => {
    if (tokenFailed(error).kind !== "hold") {
      options.log("error", { event: "push.fcm_auth_failed", status: null, code: "unreachable" });
    }
  });

  return {
    target: "fcm",
    send: async (message, deadline) => {
      if (heldUntil > now()) return { kind: "hold", code: "fcm_auth", holdMs: heldUntil - now() };
      const until = Math.min(deadline.getTime(), Date.now() + FCM_REQUEST_MS);
      const outcome = await exchange(message, until);
      if (!isH2Answer(outcome)) return outcome;
      const result = fcmResult(outcome);
      if (result.kind === "failed") {
        const status = outcome.kind === "answer" ? outcome.status : null;
        options.log("error", { event: "push.fcm_refused", status, code: result.code });
      }
      return result;
    },
    close: client.close,
  };
}
