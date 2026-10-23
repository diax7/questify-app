import { formatEventTime, formatNumber, type Theme } from "@questify/shared";
import { router } from "expo-router";
import { Pressable } from "react-native";
import { AppText } from "#src/components/AppText.tsx";
import type { Win } from "#src/event/home-api.ts";
import { useI18n } from "#src/i18n/provider.tsx";
import { textIn } from "#src/i18n/text.ts";
import { useThemedStyles } from "#src/theme/theme.tsx";

/**
 * The winner's card on Home (FR-1718, T-214): their rank, their prize and the claim deadline, until they collect it. A
 * tap opens Rewards, where the prize waits at the desk like any reserved item. The push joins with T-501.
 */
export function WinCard({
  eventId,
  win,
  timeZone,
}: Readonly<{ eventId: string; win: Win | null; timeZone: string }>) {
  const { t, language } = useI18n();
  const styles = useThemedStyles(makeStyles);
  if (win === null) {
    return null;
  }
  const deadline =
    win.claimUntil === null ? "" : formatEventTime(new Date(win.claimUntil), timeZone, language);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityHint={t("win.open")}
      onPress={() => router.navigate({ pathname: "/event/[eventId]/rewards", params: { eventId } })}
      style={styles.card}
    >
      <AppText variant="title">{t("win.title")}</AppText>
      <AppText>
        {t("win.body", {
          rank: formatNumber(win.rank, language),
          prize: textIn(win.prize.name, language),
          deadline,
        })}
      </AppText>
    </Pressable>
  );
}

const makeStyles = (theme: Theme) => ({
  card: {
    gap: theme.spacing.sm,
    padding: theme.spacing.lg,
    borderRadius: theme.radius.lg,
    borderWidth: 2,
    borderColor: theme.colors.navigationActive,
    backgroundColor: theme.colors.highlight,
  },
});
