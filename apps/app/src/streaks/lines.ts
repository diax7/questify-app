import type { Language, MessageKey } from "@questify/shared";
import type { Translate } from "#src/i18n/words.ts";
import { daysLabel } from "#src/streaks/days.ts";

/** What a streak card needs from the server: the length, and whether today counted or the event is closed today. */
export type StreakInput = Readonly<{ days: number; playedToday: boolean; closedToday: boolean }>;

export type StreakState = "closed" | "closedSafe" | "played" | "keepGoing" | "fresh";

/**
 * Which line the card says. A closed event day is read first: it writes no day row, so `playedToday` is false then
 * (T-405 code review), and the card must say the event is closed rather than invite the player to play.
 */
export function streakState(streak: StreakInput): StreakState {
  if (streak.closedToday) {
    return streak.days > 0 ? "closedSafe" : "closed";
  }
  if (streak.playedToday) {
    return "played";
  }
  return streak.days > 0 ? "keepGoing" : "fresh";
}

const DETAIL: Readonly<Record<StreakState, MessageKey>> = {
  closed: "streak.closed",
  closedSafe: "streak.closedSafe",
  played: "streak.played",
  keepGoing: "streak.keepGoing",
  fresh: "streak.fresh",
};

/**
 * The card's two lines (ADR-300): "3 days in a row" (none at 0) and one neutral sentence. Nothing counts down, nothing
 * warns of a loss, and a streak that ended reads "Start a new streak today".
 */
export function streakLines(
  streak: StreakInput,
  t: Translate,
  language: Language,
): Readonly<{ headline: string | null; detail: string }> {
  return {
    headline:
      streak.days > 0
        ? t("streak.inARow", { days: daysLabel(t, streak.days, language, "subject") })
        : null,
    detail: t(DETAIL[streakState(streak)]),
  };
}

/** The lines read aloud as one label: each without its closing full stop, joined by ". " (a screen reader pauses there). */
export function spokenLabel(lines: ReadonlyArray<string | null>): string {
  return lines
    .filter((line): line is string => line !== null)
    .map((line) => line.replace(/\.$/, ""))
    .join(". ");
}
