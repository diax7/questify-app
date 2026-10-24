/** The longest a flash quest runs, in minutes (T-307, ADR-231); a launch takes 1 to this many. */
export const FLASH_MAX_MINUTES = 1440;
/** What the Launch dialog starts with. */
export const FLASH_DEFAULT_MINUTES = 15;

/** Where a flash quest stands on the quest list (T-307): a draft, scheduled, running until its end, or ended. */
export type FlashState = "draft" | "scheduled" | "running" | "ended";

/** A quest's flash state at `now`, or null when it is not a flash quest. */
export function flashStateOf(
  quest: Readonly<{
    flash: boolean;
    visible: boolean;
    opensAt: string | null;
    closesAt: string | null;
  }>,
  now: number,
): FlashState | null {
  if (!quest.flash) {
    return null;
  }
  if (!quest.visible || quest.opensAt === null || quest.closesAt === null) {
    return "draft";
  }
  if (Date.parse(quest.opensAt) > now) {
    return "scheduled";
  }
  return Date.parse(quest.closesAt) > now ? "running" : "ended";
}

/** Whether Launch's minutes are a whole number from 1 to 1,440. */
export const flashMinutesValid = (minutes: number): boolean =>
  Number.isInteger(minutes) && minutes >= 1 && minutes <= FLASH_MAX_MINUTES;

/**
 * Whether a shown flash quest's window (wall-clock `YYYY-MM-DDTHH:mm` in the event's zone) is one the API takes: both
 * times, the end after the start, at most 24 hours apart. A hidden draft needs none. Read as UTC: both times share the
 * zone, so their difference is the same.
 */
export function flashWindowValid(
  draft: Readonly<{ visible: boolean; opensAt: string; closesAt: string }>,
): boolean {
  if (!draft.visible) {
    return true;
  }
  if (draft.opensAt === "" || draft.closesAt === "") {
    return false;
  }
  const length = Date.parse(`${draft.closesAt}Z`) - Date.parse(`${draft.opensAt}Z`);
  return length >= 60_000 && length <= FLASH_MAX_MINUTES * 60_000;
}
