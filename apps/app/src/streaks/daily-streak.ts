import {
  dailyStreakSchema,
  type DailyStreak,
  type Language,
  type SyncDailyStreak,
} from "@questify/shared";
import type { Translate } from "#src/i18n/words.ts";
import { daysLabel } from "#src/streaks/days.ts";
import { spokenLabel, streakLines } from "#src/streaks/lines.ts";

/** The profile's daily streak, or null for none (the platform switch is off), anything not well formed, or an older API. */
export function dailyStreakOf(value: unknown): DailyStreak | null {
  const parsed = dailyStreakSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** What the profile shows and says aloud: the length, one neutral line, and the next reward when there is one. */
export type DailyStreakText = Readonly<{
  headline: string | null;
  detail: string;
  next: string | null;
  label: string;
}>;

export function dailyStreakText(
  streak: DailyStreak,
  t: Translate,
  language: Language,
): DailyStreakText {
  const { headline, detail } = streakLines(
    { days: streak.days, playedToday: streak.today, closedToday: false },
    t,
    language,
  );
  const next =
    streak.next === null
      ? null
      : t("streak.next", {
          xp: streak.next.xp,
          days: daysLabel(t, streak.next.days, language),
        });
  return {
    headline,
    detail,
    next,
    label: spokenLabel([t("profile.streak"), headline, detail, next]),
  };
}

/** One light toast for each milestone a sync paid: "Streak of 7 days! +100 XP". */
export function streakNotices(
  streak: SyncDailyStreak | null,
  t: Translate,
  language: Language,
): string[] {
  return (streak?.rewards ?? []).map((reward) =>
    t("sync.streak", { days: daysLabel(t, reward.days, language), xp: reward.xp }),
  );
}
