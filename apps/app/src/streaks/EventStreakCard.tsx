import type { EventStreak, Theme } from "@questify/shared";
import { View } from "react-native";
import { AppText } from "#src/components/AppText.tsx";
import { useTerms } from "#src/event/EventContext.tsx";
import { useI18n } from "#src/i18n/provider.tsx";
import { streakCardText } from "#src/streaks/event-streak.ts";
import { FlameIcon } from "#src/streaks/FlameIcon.tsx";
import { useThemedStyles } from "#src/theme/theme.tsx";

/**
 * The player's event day streak on event Home (T-405b, FR-417): days in a row, one neutral sentence, and the
 * organizer's bonus when there is one. Shown only while the streak is on (Home sends null otherwise). No countdown, no
 * alert colour and no loss copy (ADR-300). The card is one element for a screen reader.
 */
export function EventStreakCard({ streak }: Readonly<{ streak: EventStreak | null }>) {
  const { t, language } = useI18n();
  const terms = useTerms();
  const styles = useThemedStyles(makeStyles);
  if (streak === null) {
    return null;
  }
  const text = streakCardText(streak, t, terms, language);
  return (
    <View accessible accessibilityLabel={text.label} style={styles.card}>
      <View style={styles.row}>
        <FlameIcon size={36} />
        <View style={styles.grow}>
          <AppText variant="title">{t("streak.title")}</AppText>
          {text.headline === null ? null : <AppText variant="label">{text.headline}</AppText>}
        </View>
      </View>
      <AppText>{text.detail}</AppText>
      {text.bonus === null ? null : <AppText muted>{text.bonus}</AppText>}
    </View>
  );
}

const makeStyles = (theme: Theme) => ({
  card: {
    gap: theme.spacing.sm,
    padding: theme.spacing.lg,
    borderRadius: theme.radius.lg,
    borderWidth: 2,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  row: { flexDirection: "row" as const, gap: theme.spacing.md, alignItems: "center" as const },
  grow: { flex: 1 },
});
