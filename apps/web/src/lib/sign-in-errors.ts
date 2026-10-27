import type { Language, MessageKey } from "@questify/shared";
import type { Translate } from "#src/lib/language.ts";

export type Problem = Readonly<{
  text: string;
  /** Start again from the password step (the code ran out or no resends are left). */
  restart: boolean;
  /** Seconds until another code may be asked for, when the API said so (`resend_too_soon`). */
  resendWaitSeconds?: number;
}>;

/** The API waits this long before another code may be sent (apps/api/src/auth/limits.ts). */
export const RESEND_SPACING_SECONDS = 60;

/** Why the API refused a new password (`weak_password`), in the person's words. */
const WEAK_REASONS: Readonly<Record<string, MessageKey>> = {
  too_short: "staff.weak.tooShort",
  too_long: "staff.weak.tooLong",
  same_as_email: "staff.weak.sameAsEmail",
  context_word: "staff.weak.contextWord",
  breached: "staff.weak.breached",
};

/** Why the API refused to change the shop's days (`shop_window_locked`, ADR-336), in the person's words. */
const WINDOW_LOCKED_REASONS: Readonly<Record<string, MessageKey>> = {
  shorter: "rewards.windowLocked.shorter",
  closed: "rewards.windowLocked.closed",
};

/** Codes after which the code step cannot go on. */
const RESTART_CODES = new Set(["challenge_expired", "resend_limit"]);

/** Seconds as `m:ss`, so no Arabic plural form is needed. */
export function formatWait(seconds: number): string {
  const whole = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** The API's error code in a failed answer, or undefined when the body is not the API's error envelope. */
export function errorCodeOf(body: unknown): string | undefined {
  const code = isRecord(body) ? body["code"] : undefined;
  return typeof code === "string" ? code : undefined;
}

/** The person's words for a refusal the API explains with a `reason` in its details; undefined for any other. */
function reasonWords(code: string, details: Record<string, unknown>): MessageKey | undefined {
  const reasons =
    code === "weak_password"
      ? WEAK_REASONS
      : code === "shop_window_locked"
        ? WINDOW_LOCKED_REASONS
        : undefined;
  return reasons?.[String(details["reason"])];
}

/**
 * What to tell the person after a failed sign-in step. The API already words every error in both languages; this
 * adds the wait or the attempts left from its details. Anything that is not the API's error body (a proxy page, a
 * dropped connection) gets the generic network text.
 */
export function describeProblem(body: unknown, language: Language, t: Translate): Problem {
  const message =
    isRecord(body) && isRecord(body["message"]) ? body["message"][language] : undefined;
  const code = isRecord(body) ? body["code"] : undefined;
  if (typeof message !== "string" || typeof code !== "string") {
    return { text: t("error.network"), restart: false };
  }
  const details = isRecord(body) && isRecord(body["details"]) ? body["details"] : {};
  const reasoned = reasonWords(code, details);
  if (reasoned !== undefined) {
    return { text: t(reasoned), restart: false };
  }
  const extra: string[] = [];
  const wait = details["retryAfterSeconds"];
  if (typeof wait === "number" && wait > 0) {
    extra.push(t("staff.tryAgainIn", { time: formatWait(wait) }));
  }
  const attempts = details["attemptsLeft"];
  if (typeof attempts === "number") {
    extra.push(t("staff.attemptsLeft", { count: attempts }));
  }
  const problem = { text: [message, ...extra].join(" "), restart: RESTART_CODES.has(code) };
  return code === "resend_too_soon" && typeof wait === "number" && wait > 0
    ? { ...problem, resendWaitSeconds: Math.ceil(wait) }
    : problem;
}
