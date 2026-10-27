import type { DailyStreak, Theme } from "@questify/shared";
import { View } from "react-native";
import { AppText } from "#src/components/AppText.tsx";
import { useI18n } from "#src/i18n/provider.tsx";
import { dailyStreakText } from "#src/streaks/daily-streak.ts";
import { FlameIcon } from "#src/streaks/FlameIcon.tsx";
import { useThemedStyles } from "#src/theme/theme.tsx";

/**
 * The player's Questify daily streak on their own profile, beside the gems (T-405b, FR-419): days in a row, one neutral
 * sentence and the next reward. Hidden while the platform switch is off (`/v1/me` sends null). Nobody else sees it,
 * and nothing counts down (ADR-300).
 */
export function DailyStreakCard({ streak }: Readonly<{ streak: DailyStreak | null | undefined }>) {
  const { t, language } = useI18n();
  const styles = useThemedStyles(makeStyles);
  if (streak === null || streak === undefined) {
    return null;
  }
  const text = dailyStreakText(streak, t, language);
  return (
    <View accessible accessibilityLabel={text.label} style={styles.card}>
      <AppText variant="label">{t("profile.streak")}</AppText>
      <View style={styles.row}>
        <FlameIcon size={28} />
        <AppText variant="title">{text.headline ?? text.detail}</AppText>
      </View>
      {text.headline === null ? null : <AppText muted>{text.detail}</AppText>}
      {text.next === null ? null : <AppText muted>{text.next}</AppText>}
    </View>
  );
}

// Like the level and the gems above it on the profile: no frame, a small gap.
const makeStyles = (theme: Theme) => ({
  card: { gap: theme.spacing.xs },
  row: { flexDirection: "row" as const, gap: theme.spacing.md, alignItems: "center" as const },
});
