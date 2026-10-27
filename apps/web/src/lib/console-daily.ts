import {
  adminDailyQuestionsSchema,
  dailyCadenceChangeSchema,
  dailyConsoleSchema,
  eventDayOf,
  formatLocalDate,
  wordListChangeSchema,
  wordListPageSchema,
  type AdminDailyQuestion,
  type DailyCadence,
  type DailyCadenceChange,
  type DailyConsole,
  type DailyKind,
  type DailyLanguage,
  type Language,
  type MessageKey,
  type WordListChange,
  type WordListPage,
} from "@questify/shared";
import { errorCodeOf } from "#src/lib/sign-in-errors.ts";

/** The Questify day starts at 04:00 Riyadh time (T-405): content is keyed by it and freezes when its day comes. */
const DAY_ZONE = "Asia/Riyadh";
const DAY_START_HOUR = 4;
const DAY_MS = 86_400_000;

/** How many days ahead the schedule shows (the API reads at most 120). */
export const SCHEDULE_DAYS = 56;

export const API = "/v1/admin/daily";

/** The Questify day an instant belongs to, as `YYYY-MM-DD`. */
export const questifyDayOf = (instant: Date): string =>
  eventDayOf(instant, DAY_ZONE, DAY_START_HOUR);

/** A calendar day moved by whole days (`YYYY-MM-DD` in, `YYYY-MM-DD` out). */
export function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** The days the schedule asks the API for, starting at today's Questify day. */
export function scheduleRange(today: string): Readonly<{ from: string; to: string }> {
  return { from: today, to: addDays(today, SCHEDULE_DAYS - 1) };
}

/** Whether a write can change the question bank: a question, or a challenge (it holds questions). */
export const touchesBank = (path: string): boolean => /^\/(questions|challenges)(\/|$)/.test(path);

/** Whether a period starting on `startsOn` has begun, so its content can no longer change. */
export const hasStarted = (startsOn: string, today: string): boolean => startsOn <= today;

const LOCALES: Readonly<Record<Language, string>> = {
  ar: "ar-u-ca-gregory-nu-latn",
  en: "en-GB",
};

/** A day for people with its weekday: "Sun 4 Oct 2026" (Gregorian, Western digits in both languages). */
export function formatDay(day: string, language: Language): string {
  const weekday = new Intl.DateTimeFormat(LOCALES[language], {
    timeZone: "UTC",
    weekday: "short",
  }).format(new Date(`${day}T00:00:00Z`));
  return `${weekday} ${formatLocalDate(day, language)}`;
}

/** A period for people: one day, or the first and last day of a week. */
export function formatPeriod(startsOn: string, endsOn: string, language: Language): string {
  return startsOn === endsOn
    ? formatDay(startsOn, language)
    : `${formatDay(startsOn, language)} - ${formatDay(endsOn, language)}`;
}

/** A text in the reader's language, else the other one. */
export const textIn = (text: Readonly<{ ar: string; en: string }>, language: Language): string =>
  text[language] || text[language === "ar" ? "en" : "ar"];

/** A section's answer, or undefined when it is not the expected shape (a changed API shows the error state). */
export function readDailyConsole(body: unknown): DailyConsole | undefined {
  const parsed = dailyConsoleSchema.safeParse(body);
  return parsed.success ? parsed.data : undefined;
}

/** One page of the question bank. */
export function readQuestions(body: unknown): AdminDailyQuestion[] | undefined {
  const parsed = adminDailyQuestionsSchema.safeParse(body);
  return parsed.success ? parsed.data.questions : undefined;
}

/** One page of a guess list. */
export function readWordListPage(body: unknown): WordListPage | undefined {
  const parsed = wordListPageSchema.safeParse(body);
  return parsed.success ? parsed.data : undefined;
}

/** What a guess list change did. */
export function readListChange(body: unknown): WordListChange | undefined {
  const parsed = wordListChangeSchema.safeParse(body);
  return parsed.success ? parsed.data : undefined;
}

/** What a cadence change did: the day it applies from, or that it changed nothing; the count of stranded items. */
export function readCadenceChange(body: unknown): DailyCadenceChange | undefined {
  const parsed = dailyCadenceChangeSchema.safeParse(body);
  return parsed.success ? parsed.data : undefined;
}

/** A kind's cadence today and the change waiting for tomorrow. */
export type CadenceState = Readonly<{
  cadence: DailyCadence;
  next: Readonly<{ cadence: DailyCadence; from: string }> | null;
}>;

export type Warning = Readonly<{
  kind: DailyKind;
  language: DailyLanguage | null;
  coveredDays: number;
  coveredPeriods: number;
}>;

/** The kinds that are running low (FR-1733, FR-1811, FR-1814): the challenge, and each word language on its own. */
export function warningsOf(status: DailyConsole["status"]): Warning[] {
  const found: Warning[] = [];
  const { challenge, word } = status;
  if (challenge.warn) {
    found.push({ kind: "challenge", language: null, ...coverOf(challenge) });
  }
  for (const language of ["ar", "en"] as const) {
    if (word[language].warn) {
      found.push({ kind: "word", language, ...coverOf(word[language]) });
    }
  }
  return found;
}

const coverOf = (cover: Readonly<{ coveredDays: number; coveredPeriods: number }>) => ({
  coveredDays: cover.coveredDays,
  coveredPeriods: cover.coveredPeriods,
});

/** Whether any content is running low, for the console menu badge. */
export const hasWarning = (status: DailyConsole["status"]): boolean =>
  warningsOf(status).length > 0;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const CONFLICT_KEYS: Readonly<Record<string, MessageKey>> = {
  started: "console.daily.conflict.started",
  scheduled: "console.daily.conflict.scheduled",
  retired: "console.daily.conflict.retired",
  changed: "console.daily.conflict.changed",
};

const FIELD_KEYS: Readonly<Record<string, MessageKey>> = {
  prompt: "console.daily.invalid.prompt",
  options: "console.daily.invalid.options",
  answer: "console.daily.invalid.answer",
  questions: "console.daily.invalid.questions",
  sponsor: "console.daily.invalid.sponsor",
  word: "console.daily.invalid.word",
  not_period_start: "console.daily.invalid.notPeriodStart",
};

export type Refusal = Readonly<{
  key: MessageKey;
  params: Readonly<Record<string, number>>;
}>;

const NO_PARAMS = {} as const;

/** The words for a 409 `daily_content_conflict`: a question named by its place, a word, or the reason alone. */
function conflictRefusal(details: Record<string, unknown>): Refusal {
  const position = details["position"];
  if (details["reason"] !== "used") {
    return {
      key: CONFLICT_KEYS[String(details["reason"])] ?? "console.daily.conflict.other",
      params: NO_PARAMS,
    };
  }
  return typeof position === "number"
    ? { key: "console.daily.conflict.usedQuestion", params: { position } }
    : { key: "console.daily.conflict.usedWord", params: NO_PARAMS };
}

/**
 * The words for the API's daily refusals: a 409 `daily_content_conflict {reason, position?}` and a 422
 * `invalid_daily {field}`. Anything else is undefined so the caller can show the API's own message.
 */
export function refusalOf(body: unknown): Refusal | undefined {
  const details = isRecord(body) && isRecord(body["details"]) ? body["details"] : {};
  const code = errorCodeOf(body);
  if (code === "daily_content_conflict") {
    return conflictRefusal(details);
  }
  if (code === "invalid_daily") {
    return {
      key: FIELD_KEYS[String(details["field"])] ?? "console.daily.invalid.other",
      params: NO_PARAMS,
    };
  }
  return undefined;
}

/** The message that names a word language in the reader's language. */
export const LANGUAGE_NAME_KEY = {
  ar: "console.daily.language.ar",
  en: "console.daily.language.en",
} as const satisfies Record<DailyLanguage, MessageKey>;
