import type { Language } from "@questify/shared";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const PASSED_RETRY = 30_000;

type Unit = "day" | "hour" | "minute";

/** Each unit's Arabic forms after «بعد»: one, two, 3 to 10, 11 to 99, and the hundreds (CLDR's one, two, few, many, other). */
const ARABIC: Readonly<Record<Unit, readonly [string, string, string, string, string]>> = {
  day: ["يوم", "يومين", "{n} أيام", "{n} يومًا", "{n} يوم"],
  hour: ["ساعة", "ساعتين", "{n} ساعات", "{n} ساعة", "{n} ساعة"],
  minute: ["دقيقة", "دقيقتين", "{n} دقائق", "{n} دقيقة", "{n} دقيقة"],
};

const ENGLISH: Readonly<Record<Unit, readonly [string, string]>> = {
  day: ["1 day", "{n} days"],
  hour: ["1 hour", "{n} hours"],
  minute: ["1 minute", "{n} minutes"],
};

function arabicForm(unit: Unit, n: number): string {
  const [one, two, few, many, other] = ARABIC[unit];
  const tens = n % 100;
  const form =
    n === 1 ? one : n === 2 ? two : tens >= 3 && tens <= 10 ? few : tens >= 11 ? many : other;
  return form.replace("{n}", String(n));
}

/** A span in the largest whole unit, rounded down: "3 days", «ساعتين». Western digits in both languages (ADR-018). */
export function spanText(ms: number, language: Language): string | null {
  const [unit, size]: [Unit, number] =
    ms >= DAY ? ["day", DAY] : ms >= HOUR ? ["hour", HOUR] : ["minute", MINUTE];
  const n = Math.floor(ms / size);
  if (n < 1) {
    return null;
  }
  if (language === "ar") {
    return arabicForm(unit, n);
  }
  const [one, many] = ENGLISH[unit];
  return (n === 1 ? one : many).replace("{n}", String(n));
}

type Timed = Readonly<{ statusNow: string; startsAt: string | null; endsAt: string | null }>;

/** The next moment the status changes: the start while scheduled, the end while live. */
const boundaryOf = (event: Timed): string | null =>
  event.statusNow === "scheduled"
    ? event.startsAt
    : event.statusNow === "live"
      ? event.endsAt
      : null;

export type Countdown =
  | Readonly<{ kind: "starts" | "ends"; span: string | null }>
  | Readonly<{ kind: "ended" }>;

/**
 * Home's countdown (FR-801): to the start while scheduled, to the end while live, "ended" after. The status is the
 * server's; the phone's clock only measures the span, and a span under a minute reads "in under a minute".
 */
export function countdown(event: Timed, now: number, language: Language): Countdown | null {
  if (event.statusNow === "ended" || event.statusNow === "archived") {
    return { kind: "ended" };
  }
  const target = boundaryOf(event);
  if (target === null) {
    return null;
  }
  return {
    kind: event.statusNow === "scheduled" ? "starts" : "ends",
    span: spanText(Math.max(0, Date.parse(target) - now), language),
  };
}

/**
 * When Home reads itself again so the status changes on the server's word (the start while scheduled, the end while
 * live), as a delay from now; null when no boundary is ahead. Never flips the status on the phone's clock alone.
 */
export function nextBoundary(event: Timed, now: number): number | null {
  const target = boundaryOf(event);
  if (target === null) {
    return null;
  }
  const left = Date.parse(target) - now;
  // Past the boundary on the phone's clock while the server has not crossed it (a phone running ahead): ask again in
  // half a minute, never every second. Otherwise a second past it, at most a day ahead: a timer cannot wait longer than
  // about 24 days, and a later boundary is simply looked at again then.
  return left <= 0 ? PASSED_RETRY : Math.min(left + 1000, DAY);
}
