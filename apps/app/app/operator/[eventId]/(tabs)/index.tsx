import { formatNumber, type Theme } from "@questify/shared";
import { useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { Pressable, ScrollView } from "react-native";
import { api } from "#src/api/app-session.ts";
import { AppText } from "#src/components/AppText.tsx";
import { Button } from "#src/components/Controls.tsx";
import { Screen } from "#src/components/Screen.tsx";
import { useI18n } from "#src/i18n/provider.tsx";
import { textIn } from "#src/i18n/text.ts";
import { fetchStations, type Station } from "#src/operator/operator-api.ts";
import { useOperator } from "#src/operator/OperatorContext.tsx";
import { useThemedStyles } from "#src/theme/theme.tsx";

/**
 * Operator Home (FR-921): pick the station, a quest staff verify by My QR within this operator's limit, and see how
 * many players this operator completed there today and in all. A single station is picked for them.
 */
export default function OperatorHomeScreen() {
  const { t, language } = useI18n();
  const styles = useThemedStyles(makeStyles);
  const { eventId, event, station, pickStation, removed } = useOperator();
  const [stations, setStations] = useState<readonly Station[] | undefined>(undefined);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    const answer = await fetchStations(api.session, eventId);
    if (answer.kind === "refused" && answer.code === "not_operator") {
      removed();
      return;
    }
    setFailed(answer.kind !== "stations");
    if (answer.kind !== "stations") {
      return;
    }
    setStations(answer.stations);
    const only = answer.stations.length === 1 ? answer.stations[0] : undefined;
    const kept = answer.stations.some((item) => item.questId === station?.questId);
    if (!kept) {
      pickStation(
        only === undefined ? null : { questId: only.questId, title: textIn(only.title, language) },
      );
    }
  }, [eventId, language, pickStation, removed, station?.questId]);
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  return (
    <Screen title={event === undefined ? t("operator.mode") : textIn(event.name, language)}>
      <ScrollView contentContainerStyle={{ gap: 12 }}>
        <AppText variant="title">{t("operator.pickStation")}</AppText>
        {failed ? (
          <>
            <AppText accessibilityRole="alert">{t("join.network")}</AppText>
            <Button kind="quiet" label={t("common.retry")} onPress={() => void load()} />
          </>
        ) : null}
        {stations === undefined && !failed ? <AppText muted>{t("common.loading")}</AppText> : null}
        {stations?.length === 0 ? <AppText muted>{t("operator.noStations")}</AppText> : null}
        {(stations ?? []).map((item) => {
          const picked = item.questId === station?.questId;
          const title = textIn(item.title, language);
          const counts = [
            t("operator.today", { count: formatNumber(item.doneToday, language) }),
            t("operator.total", { count: formatNumber(item.doneTotal, language) }),
          ].join("  ·  ");
          return (
            <Pressable
              key={item.questId}
              accessibilityRole="radio"
              accessibilityState={{ checked: picked }}
              onPress={() => pickStation({ questId: item.questId, title })}
              style={[styles.row, picked && styles.picked]}
            >
              <AppText variant="label">{title}</AppText>
              <AppText muted>{counts}</AppText>
            </Pressable>
          );
        })}
      </ScrollView>
    </Screen>
  );
}

const makeStyles = (theme: Theme) => ({
  row: {
    gap: theme.spacing.xs,
    padding: theme.spacing.md,
    borderRadius: theme.radius.md,
    borderWidth: 2,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  picked: { borderColor: theme.colors.primaryAction },
});
