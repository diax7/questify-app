import {
  notificationRoute,
  type Language,
  type NotificationItem,
  type NotificationList,
  type NotificationRoute,
} from "@questify/shared";

/** The notification center's list logic (P16, FR-1824), apart from the screen so it runs in tests. */

/** The next page's rows after the ones already shown; a row that is already there (the list moved) is not added twice. */
export function appendRows(
  current: readonly NotificationItem[],
  page: readonly NotificationItem[],
): readonly NotificationItem[] {
  const seen = new Set(current.map((row) => row.id));
  return [...current, ...page.filter((row) => !seen.has(row.id))];
}

/** The rows read so far (null until the first page arrives) and the cursor of the next older page (null: none). */
export type CenterList = Readonly<{
  rows: readonly NotificationItem[] | null;
  next: number | null;
}>;

/**
 * The list after the newest page was read again (the screen gained focus): the new first page replaces the old one, and
 * the older pages the player already loaded stay, so coming back from a tapped row does not lose their place. They stay
 * only when the new page overlaps them (their newest row is not newer than the new page's last), which proves nothing
 * sits between the two; when more than a page of messages arrived meanwhile, the new first page is the whole list.
 */
export function mergeFirstPage(current: CenterList, page: NotificationList): CenterList {
  const last = page.items.at(-1);
  const newestHeld = current.rows?.[0];
  const whole = { rows: page.items, next: page.nextBefore };
  if (page.nextBefore === null || last === undefined || current.rows === null) return whole;
  if (newestHeld === undefined || newestHeld.id < last.id) return whole;
  const older = current.rows.filter((row) => row.id < last.id);
  return older.length === 0 ? whole : { rows: [...page.items, ...older], next: current.next };
}

/** The rows with the named ones (or all, with `null`) shown as read. */
export function withRead(
  rows: readonly NotificationItem[],
  ids: readonly number[] | null,
): readonly NotificationItem[] {
  const named = ids === null ? null : new Set(ids);
  return rows.map((row) => (named === null || named.has(row.id) ? { ...row, read: true } : row));
}

/**
 * Where a tap on a row leads: the screen its kind opens, else nowhere (the row is already the message: a promotion
 * shows its opt-out beside it). A tap always marks the row read.
 */
export function rowRoute(row: NotificationItem): NotificationRoute {
  return notificationRoute(row.kind, row.eventId, row.refs);
}

/**
 * The join screen an invitation row's "See the event" opens (ADR-356 (6)): the event's public code, joined by link as
 * the invitation's landing page does; null for any other row.
 */
export function joinRouteOf(
  row: Pick<NotificationItem, "joinCode">,
): Readonly<{ pathname: "/join/[code]"; params: Readonly<{ code: string; via: "link" }> }> | null {
  return row.joinCode === null
    ? null
    : { pathname: "/join/[code]", params: { code: row.joinCode, via: "link" } };
}

const LOCALES: Readonly<Record<Language, string>> = {
  // Gregorian dates and Western digits in Arabic too (ADR-018).
  ar: "ar-u-ca-gregory-nu-latn",
  en: "en-GB",
};

/**
 * When a message arrived, for people: day, short month and 24-hour time in the phone's own time zone ("28 Oct, 16:05").
 * Empty when the time cannot be read, so a row never shows "Invalid Date".
 */
export function stampOf(createdAt: string, language: Language, timeZone?: string): string {
  const instant = new Date(createdAt);
  if (Number.isNaN(instant.getTime())) return "";
  return new Intl.DateTimeFormat(LOCALES[language], {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    ...(timeZone === undefined ? {} : { timeZone }),
  }).format(instant);
}
