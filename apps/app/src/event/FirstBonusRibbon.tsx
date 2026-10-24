import type { Theme } from "@questify/shared";
import { View } from "react-native";
import { AppText } from "#src/components/AppText.tsx";
import { ribbonLines, withLiveLeft, type QuestFirstBonus } from "#src/event/first-bonus.ts";
import { useLive } from "#src/event/LiveContext.tsx";
import { useI18n } from "#src/i18n/provider.tsx";
import { useThemedStyles } from "#src/theme/theme.tsx";

/**
 * The gold "First 50" ribbon of a quest with a first-N bonus (T-313, ADR-263): "+25 · 12 left", "All taken" or "You
 * got bonus #3". What is left comes from the live read the tabs already poll, never from a re-read of the quests.
 */
export function FirstBonusRibbon({
  questId,
  bonus,
}: Readonly<{ questId: string; bonus: QuestFirstBonus | null }>) {
  const { t, language } = useI18n();
  const live = useLive();
  const styles = useThemedStyles(makeStyles);
  const shown = withLiveLeft(bonus, questId, live.firstBonus);
  if (shown === null) {
    return null;
  }
  const lines = ribbonLines(shown, t, language);
  return (
    <View style={styles.row} accessible accessibilityLabel={`${lines.title}, ${lines.detail}`}>
      <AppText variant="label" style={styles.ribbon}>
        {lines.title}
      </AppText>
      <AppText muted={shown.mine === null && shown.left === 0}>{lines.detail}</AppText>
    </View>
  );
}

const makeStyles = (theme: Theme) => ({
  row: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    flexWrap: "wrap" as const,
    gap: theme.spacing.xs,
  },
  // Gold, as the brand deck's treasure: the bonus is the card's highlight.
  ribbon: {
    paddingHorizontal: theme.spacing.sm,
    borderRadius: theme.radius.sm,
    backgroundColor: theme.colors.navigationActive,
    overflow: "hidden" as const,
  },
});
