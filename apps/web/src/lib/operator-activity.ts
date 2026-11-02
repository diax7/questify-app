import {
  OPERATOR_QUIET_MINUTES,
  OPERATOR_RECENT_FIRST,
  OPERATOR_RECENT_MAX,
  type Language,
  type MessageKey,
  type OperatorAction,
  type OperatorActivityRow,
  type StaffBriefingField,
  type StaffBriefingIssue,
} from "@questify/shared";

/** The "View more" steps of the latest-actions card: the first page, a longer one, the most the read gives. */
const RECENT_STEPS: readonly number[] = [OPERATOR_RECENT_FIRST, 25, OPERATOR_RECENT_MAX];

/** The next size of the latest-actions list, or null when it is already the longest. */
export function nextRecent(current: number): number | null {
  return RECENT_STEPS.find((step) => step > current) ?? null;
}

const ACTION_KEYS: Readonly<Record<OperatorAction, MessageKey>> = {
  scan: "operatorActivity.action.scan",
  check_in: "operatorActivity.action.checkIn",
  award: "operatorActivity.action.award",
  hand_over: "operatorActivity.action.handOver",
  cancel: "operatorActivity.action.cancel",
  review: "operatorActivity.action.review",
  answer: "operatorActivity.action.answer",
};

/** The name of an operator action. */
export const actionKey = (action: OperatorAction): MessageKey => ACTION_KEYS[action];

/** Whole minutes from `lastAt` to the read's own time (the server's clock, not the browser's); null when never active. */
export function minutesQuiet(lastAt: string | null, asOf: string): number | null {
  if (lastAt === null) {
    return null;
  }
  const gap = new Date(asOf).getTime() - new Date(lastAt).getTime();
  return Math.max(0, Math.floor(gap / 60_000));
}

/** Whether an operator has done nothing for the quiet limit (30 minutes), or ever. */
export function isQuiet(row: Pick<OperatorActivityRow, "lastAt">, asOf: string): boolean {
  const quiet = minutesQuiet(row.lastAt, asOf);
  return quiet === null || quiet >= OPERATOR_QUIET_MINUTES;
}

/** The figures of the tiles: how many operators are active, and the event's scans, awards and hand-overs. */
export function summaryOf(rows: readonly OperatorActivityRow[], asOf: string) {
  return {
    active: rows.filter((row) => !isQuiet(row, asOf)).length,
    scansHour: rows.reduce((sum, row) => sum + row.scansHour, 0),
    scans: rows.reduce((sum, row) => sum + row.scans, 0),
    awards: rows.reduce((sum, row) => sum + row.awards, 0),
    handOvers: rows.reduce((sum, row) => sum + row.handOvers, 0),
  };
}

const UNITS: ReadonlyArray<readonly [Intl.RelativeTimeFormatUnit, number]> = [
  ["day", 1440],
  ["hour", 60],
  ["minute", 1],
];

/**
 * How long ago, in the person's language with Western digits ("12 minutes ago", «قبل 12 دقيقة»): the browser's own
 * plural rules, so the Arabic noun agrees with the number. "Now" under a minute.
 */
export function agoText(minutes: number, language: Language): string {
  const format = new Intl.RelativeTimeFormat(`${language}-u-nu-latn`, {
    numeric: "auto",
    style: "long",
  });
  const [unit, size] = UNITS.find(([, span]) => minutes >= span) ?? UNITS[2]!;
  return format.format(-Math.floor(minutes / size), unit);
}

const CLOCK = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** A time of day with Western digits, the same in both languages (shown in a left-to-right `time`). */
export const clockOf = (iso: string): string => CLOCK.format(new Date(iso));

const ISSUE_KEYS: Readonly<Record<StaffBriefingIssue, MessageKey>> = {
  required: "briefing.issue.required",
  too_long: "briefing.issue.tooLong",
  looks_like_address: "briefing.issue.looksLikeAddress",
  looks_like_phone: "briefing.issue.looksLikePhone",
  control_characters: "briefing.issue.controlCharacters",
};

/** The message for why a briefing field cannot be sent. */
export const issueKey = (issue: StaffBriefingIssue): MessageKey => ISSUE_KEYS[issue];

const FIELD_KEYS: Readonly<Record<StaffBriefingField, MessageKey>> = {
  titleAr: "announcements.page.titleAr",
  titleEn: "announcements.page.titleEn",
  bodyAr: "announcements.page.bodyAr",
  bodyEn: "announcements.page.bodyEn",
};

/** The label of a briefing field (the announcement composer's own labels). */
export const fieldKey = (field: StaffBriefingField): MessageKey => FIELD_KEYS[field];
