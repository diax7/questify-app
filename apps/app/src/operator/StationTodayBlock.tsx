import { formatNumber, type Theme } from "@questify/shared";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { AppState, Pressable, View } from "react-native";
import { api } from "#src/api/app-session.ts";
import { AppText } from "#src/components/AppText.tsx";
import { Button } from "#src/components/Controls.tsx";
import { useI18n } from "#src/i18n/provider.tsx";
import type { Waiting } from "#src/operator/inbox.ts";
import { fetchStationToday, type StationToday } from "#src/operator/operator-api.ts";
import { useOperator } from "#src/operator/OperatorContext.tsx";
import { useThemedStyles } from "#src/theme/theme.tsx";

/** How often Home reads the station's numbers while it is in focus and the app in the foreground. */
const REFRESH_MS = 30_000;

type Read = Readonly<{ questId: string; counts: StationToday }> | "failed" | undefined;

/**
 * My station today (FR-928, ADR-251): the picked station's completions today and in the last hour, by everyone, and
 * what waits in the Inbox (hidden for an operator with neither review nor the help desk). No station picked: a prompt
 * and no numbers. A failed read hides the last numbers rather than show them as current.
 */
export function StationTodayBlock() {
  const { t, language } = useI18n();
  const styles = useThemedStyles(makeStyles);
  const { eventId, station, removed, waiting } = useOperator();
  const [read, setRead] = useState<Read>(undefined);
  const questId = station?.questId;

  const load = useCallback(async () => {
    if (questId === undefined) {
      return;
    }
    const answer = await fetchStationToday(api.session, eventId, questId);
    if (answer.kind === "removed") {
      removed();
      return;
    }
    setRead(answer.kind === "counts" ? { questId, counts: answer.counts } : "failed");
  }, [eventId, questId, removed]);

  useFocusEffect(
    useCallback(() => {
      void load();
      const timer = setInterval(() => {
        if (AppState.currentState === "active") {
          void load();
        }
      }, REFRESH_MS);
      return () => clearInterval(timer);
    }, [load]),
  );

  const count = (value: number) => formatNumber(value, language);
  const counts = typeof read === "object" && read.questId === questId ? read.counts : undefined;
  return (
    <View style={styles.block}>
      <AppText variant="label">{t("operator.stationToday.title")}</AppText>
      <StationNumbers
        picked={questId !== undefined}
        failed={read === "failed"}
        counts={counts}
        count={count}
        retry={() => void load()}
      />
      <WaitingLink eventId={eventId} waiting={waiting} count={count} />
    </View>
  );
}

/** The station's numbers, or why there are none: no station picked, a failed read with Retry, or still loading. */
function StationNumbers({
  picked,
  failed,
  counts,
  count,
  retry,
}: Readonly<{
  picked: boolean;
  failed: boolean;
  counts: StationToday | undefined;
  count: (value: number) => string;
  retry: () => void;
}>) {
  const { t } = useI18n();
  return (
    <>
      {picked ? null : <AppText muted>{t("operator.stationToday.pick")}</AppText>}
      {picked && failed ? (
        <>
          <AppText accessibilityRole="alert">{t("operator.stationToday.failed")}</AppText>
          <Button kind="quiet" label={t("common.retry")} onPress={retry} />
        </>
      ) : null}
      {picked && !failed && counts === undefined ? (
        <AppText muted>{t("common.loading")}</AppText>
      ) : null}
      {counts === undefined ? null : (
        <>
          <AppText>{t("operator.stationToday.done", { count: count(counts.today) })}</AppText>
          <AppText>
            {t("operator.stationToday.lastHour", { count: count(counts.lastHour) })}
          </AppText>
        </>
      )}
    </>
  );
}

/** What waits in the Inbox, as a link to it; nothing when the operator has neither review nor the help desk. */
function WaitingLink({
  eventId,
  waiting,
  count,
}: Readonly<{
  eventId: string;
  waiting: Waiting | undefined;
  count: (value: number) => string;
}>) {
  const { t } = useI18n();
  return waiting?.kind === "count" ? (
    <Pressable
      accessibilityRole="link"
      hitSlop={{ top: 10, bottom: 10 }}
      onPress={() => router.push(`/operator/${eventId}/inbox`)}
    >
      <AppText>{t("operator.stationToday.waiting", { count: count(waiting.total) })}</AppText>
    </Pressable>
  ) : null;
}

const makeStyles = (theme: Theme) => ({
  block: {
    gap: theme.spacing.xs,
    padding: theme.spacing.md,
    borderRadius: theme.radius.md,
    borderWidth: 2,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
});
