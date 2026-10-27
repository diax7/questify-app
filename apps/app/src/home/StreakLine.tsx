import type { Theme } from "@questify/shared";
import { View } from "react-native";
import { usePlayer } from "#src/auth/player.tsx";
import { AppText } from "#src/components/AppText.tsx";
import { useI18n } from "#src/i18n/provider.tsx";
import { dailyStreakText } from "#src/streaks/daily-streak.ts";
import { FlameIcon } from "#src/streaks/FlameIcon.tsx";
import { useThemedStyles } from "#src/theme/theme.tsx";

/**
 * The daily streak as one line on Questify Home (T-405, FR-832): the flame, its length and whether today is played.
 * Nothing at all when the profile has no streak (`dailyStreak` null: the platform switch is off, or an older API).
 */
export function StreakLine() {
  const { t, language } = useI18n();
  const { state } = usePlayer();
  const styles = useThemedStyles(makeStyles);
  const streak = state.status === "signed_in" ? state.me?.dailyStreak : undefined;
  if (streak === null || streak === undefined) {
    return null;
  }
  const text = dailyStreakText(streak, t, language);
  return (
    <View accessible accessibilityLabel={text.label} style={styles.row}>
      <FlameIcon size={24} />
      <AppText variant="label">{text.headline ?? text.detail}</AppText>
      {text.headline === null ? null : <AppText muted>{text.detail}</AppText>}
    </View>
  );
}

const makeStyles = (theme: Theme) => ({
  row: {
    flexDirection: "row" as const,
    flexWrap: "wrap" as const,
    alignItems: "center" as const,
    gap: theme.spacing.sm,
  },
});
