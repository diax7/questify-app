import { formatNumber, type Theme } from "@questify/shared";
import { useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { Pressable, ScrollView } from "react-native";
import { api } from "#src/api/app-session.ts";
import { AppText } from "#src/components/AppText.tsx";
import { Button } from "#src/components/Controls.tsx";
import { RehearsalStrip } from "#src/components/RehearsalStrip.tsx";
import { isRehearsalStatus } from "#src/event/rehearsal.ts";
import { Screen } from "#src/components/Screen.tsx";
import { useI18n } from "#src/i18n/provider.tsx";
import { textIn } from "#src/i18n/text.ts";
import { fetchStations, type Station } from "#src/operator/operator-api.ts";
import { useOperator } from "#src/operator/OperatorContext.tsx";
import { StationTodayBlock } from "#src/operator/StationTodayBlock.tsx";
import { BellRow } from "#src/push/NotificationBell.tsx";
import { useThemedStyles } from "#src/theme/theme.tsx";

/** What the picker says before it has stations: the failure with Retry, the loading line, or that there are none. */
function StationNotes({
  stations,
  failed,
  retry,
}: Readonly<{ stations: readonly Station[] | undefined; failed: boolean; retry: () => void }>) {
  const { t } = useI18n();
  return (
    <>
      {failed ? (
        <>
          <AppText accessibilityRole="alert">{t("join.network")}</AppText>
          <Button kind="quiet" label={t("common.retry")} onPress={retry} />
        </>
      ) : null}
      {stations === undefined && !failed ? <AppText muted>{t("common.loading")}</AppText> : null}
      {stations?.length === 0 ? <AppText muted>{t("operator.noStations")}</AppText> : null}
    </>
  );
}

/** One station in the picker, with the players this operator completed there today and in all. */
function StationRow({
  item,
  picked,
  onPick,
}: Readonly<{ item: Station; picked: boolean; onPick: (title: string) => void }>) {
  const { t, language } = useI18n();
  const styles = useThemedStyles(makeStyles);
  const title = textIn(item.title, language);
  const counts = [
    ...(item.challenge ? [t("operator.station.challenge")] : []),
    t("operator.today", { count: formatNumber(item.doneToday, language) }),
    t("operator.total", { count: formatNumber(item.doneTotal, language) }),
  ].join("  ·  ");
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ checked: picked }}
      onPress={() => onPick(title)}
      style={[styles.row, picked && styles.picked]}
    >
      <AppText variant="label">{title}</AppText>
      <AppText muted>{counts}</AppText>
    </Pressable>
  );
}

/**
 * Operator Home (FR-921): pick the station, a quest staff verify by My QR within this operator's limit, and see how
 * many players this operator completed there today and in all. A single station is picked for them. Under the picker,
 * My station today (FR-928) counts the picked station for everyone. The bell opens the notification center, where the
 * owner's staff briefing (T-617) waits when push is not delivered.
 */
export default function OperatorHomeScreen() {
  const { t, language } = useI18n();
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
    <Screen
      title={event === undefined ? t("operator.mode") : textIn(event.name, language)}
      header={<BellRow />}
    >
      <ScrollView contentContainerStyle={{ gap: 12 }}>
        <RehearsalStrip shown={isRehearsalStatus(event?.statusNow)} />
        <AppText variant="title">{t("operator.pickStation")}</AppText>
        <StationNotes stations={stations} failed={failed} retry={() => void load()} />
        {(stations ?? []).map((item) => (
          <StationRow
            key={item.questId}
            item={item}
            picked={item.questId === station?.questId}
            onPick={(title) => pickStation({ questId: item.questId, title })}
          />
        ))}
        <StationTodayBlock />
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
