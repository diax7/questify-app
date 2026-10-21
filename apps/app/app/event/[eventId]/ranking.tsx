import type { Theme } from "@questify/shared";
import { useCallback, useEffect, useState } from "react";
import { ScrollView, View } from "react-native";
import { api } from "#src/api/app-session.ts";
import { AppText } from "#src/components/AppText.tsx";
import { Button } from "#src/components/Controls.tsx";
import { BackButton } from "#src/components/BackButton.tsx";
import { Screen } from "#src/components/Screen.tsx";
import { useEvent } from "#src/event/EventContext.tsx";
import { fetchRanking, type RankingAnswer } from "#src/event/home-api.ts";
import { useI18n } from "#src/i18n/provider.tsx";
import { useThemedStyles } from "#src/theme/theme.tsx";

/** The event's ranking (FR-802), plainly: the top 10 and the player's own row. T-116 gives it its final form. */
export default function RankingScreen() {
  const { t } = useI18n();
  const { eventId } = useEvent();
  const styles = useThemedStyles(makeStyles);
  const [answer, setAnswer] = useState<RankingAnswer | undefined>(undefined);
  const load = useCallback(
    async () => setAnswer(await fetchRanking(api.session, eventId)),
    [eventId],
  );
  useEffect(() => {
    void load();
  }, [load]);

  if (answer?.kind !== "ranking") {
    return (
      <Screen title={t("nav.ranking")} header={<BackButton />}>
        {answer === undefined ? <AppText muted>{t("common.loading")}</AppText> : null}
        {answer?.kind === "off" ? <AppText>{t("ranking.off")}</AppText> : null}
        {answer?.kind === "network" ? (
          <>
            <AppText accessibilityRole="alert">{t("eventHome.rankingFailed")}</AppText>
            <Button label={t("common.retry")} onPress={() => void load()} />
          </>
        ) : null}
      </Screen>
    );
  }
  const { rows, me } = answer.ranking;
  const meShown = rows.some((row) => row.isMe);
  return (
    <Screen title={t("nav.ranking")} header={<BackButton />}>
      <ScrollView contentContainerStyle={{ gap: 8 }}>
        {rows.map((row) => (
          <View key={row.username} style={[styles.row, row.isMe && styles.mine]}>
            <AppText variant="label">{row.rank}</AppText>
            <AppText style={styles.grow}>@{row.username}</AppText>
            <AppText>{row.score}</AppText>
          </View>
        ))}
        {me === null ? <AppText muted>{t("eventHome.noRank")}</AppText> : null}
        {me !== null && !meShown ? (
          <View style={[styles.row, styles.mine]}>
            <AppText variant="label">{me.rank}</AppText>
            <AppText style={styles.grow}>@{me.username}</AppText>
            <AppText>{me.score}</AppText>
          </View>
        ) : null}
      </ScrollView>
    </Screen>
  );
}

const makeStyles = (theme: Theme) => ({
  row: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: theme.spacing.md,
    padding: theme.spacing.md,
    borderRadius: theme.radius.md,
    borderWidth: 2,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  mine: { borderColor: theme.colors.highlight },
  grow: { flex: 1 },
});
