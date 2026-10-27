import {
  eventStreakSchema,
  formatNumber,
  streakBonusSchema,
  termFor,
  type EventStreak,
  type EventTerms,
  type Language,
  type StreakBonus,
} from "@questify/shared";
import type { Translate } from "#src/i18n/words.ts";
import { spokenLabel, streakLines } from "#src/streaks/lines.ts";

/** Home's event streak, or null for none (the streak is off), anything not well formed, or an older API. */
export function eventStreakOf(value: unknown): EventStreak | null {
  const parsed = eventStreakSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** A completion answer's streak bonus, or null for none, anything not well formed, or an older API. */
export function streakBonusPaidOf(value: unknown): StreakBonus | null {
  const parsed = streakBonusSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** The success card's line: "Streak day 3! +25". */
export function streakBonusLine(t: Translate, paid: StreakBonus): string {
  return t("streak.bonusPaid", { days: paid.days, points: paid.points });
}

/** The history row's label: "Streak bonus, day 3". */
export const streakHistoryLabel = (t: Translate, days: number): string =>
  t("history.streak", { days });

/** What the event Home card shows and says aloud. `bonus` is null when the organizer set none. */
export type StreakCardText = Readonly<{
  headline: string | null;
  detail: string;
  bonus: string | null;
  label: string;
}>;

export function streakCardText(
  streak: EventStreak,
  t: Translate,
  terms: EventTerms,
  language: Language,
): StreakCardText {
  const { headline, detail } = streakLines(streak, t, language);
  const bonus =
    streak.bonusPoints === null
      ? null
      : t("streak.bonus", {
          points: formatNumber(streak.bonusPoints, language),
          currency: termFor(terms.currency, language, streak.bonusPoints),
        });
  return {
    headline,
    detail,
    bonus,
    label: spokenLabel([t("streak.title"), headline, detail, bonus]),
  };
}
