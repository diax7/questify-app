import { type MemberAnnouncement, type Theme } from "@questify/shared";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useState } from "react";
import { ScrollView, View } from "react-native";
import { api } from "#src/api/app-session.ts";
import { AppText } from "#src/components/AppText.tsx";
import { BackButton } from "#src/components/BackButton.tsx";
import { Button } from "#src/components/Controls.tsx";
import { Screen } from "#src/components/Screen.tsx";
import { memberAnnouncementsOf, happeningNow, type Happening } from "#src/event/announcements.ts";
import { fetchQuests } from "#src/event/quests-api.ts";
import { useI18n } from "#src/i18n/provider.tsx";
import { textIn } from "#src/i18n/text.ts";
import { stampOf } from "#src/push/center.ts";
import { useThemedStyles } from "#src/theme/theme.tsx";

async function readRunning(eventId: string): Promise<Happening[]> {
  const quests = await fetchQuests(api.session, eventId);
  if (quests.kind !== "quests") return [];
  if (["ended", "archived"].includes(quests.view.event.statusNow)) return [];
  return happeningNow(quests.view.categories, Date.now());
}

function useAnnouncementReads(eventId: string, full: boolean) {
  const [rows, setRows] = useState<MemberAnnouncement[]>();
  const [running, setRunning] = useState<Happening[]>([]);
  const [failed, setFailed] = useState(false);
  const [attempt, retry] = useState(0);
  useFocusEffect(
    useCallback(() => {
      let active = true;
      const load = async () => {
        const answer = await api.session.request({
          method: "GET",
          path: `/v1/events/${encodeURIComponent(eventId)}/announcements?size=${full ? 50 : 3}`,
        });
        if (!active) return;
        if (answer.kind === "signed_out") {
          router.replace("/sign-in");
          return;
        }
        const read = answer.kind === "ok" ? memberAnnouncementsOf(answer.body) : undefined;
        setFailed(read === undefined);
        setRows(read);
        if (!full) {
          const found = await readRunning(eventId);
          if (active) setRunning(found);
        }
      };
      setRows(undefined);
      setRunning([]);
      setFailed(false);
      void load();
      const timer = setInterval(() => void load(), 30_000);
      return () => {
        active = false;
        clearInterval(timer);
      };
    }, [eventId, full, attempt]),
  );
  return { rows, running, failed, retry: () => retry((value) => value + 1) };
}

function AnnouncementRows({ rows }: Readonly<{ rows: readonly MemberAnnouncement[] }>) {
  const { language } = useI18n();
  const styles = useThemedStyles(makeStyles);
  return (
    <>
      {rows.map((row) => (
        <View key={row.id} style={styles.card}>
          <AppText variant="label">{textIn(row.title, language)}</AppText>
          <AppText>{textIn(row.body, language)}</AppText>
          <AppText muted>{stampOf(row.sentAt, language)}</AppText>
        </View>
      ))}
    </>
  );
}

export function EventHomeStrips({ eventId }: Readonly<{ eventId: string }>) {
  const { t, language } = useI18n();
  const state = useAnnouncementReads(eventId, false);
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.list}>
      <Button
        kind="quiet"
        label={t("agenda.link")}
        onPress={() => router.push(`/event/${eventId}/agenda`)}
      />
      {state.running.length === 0 ? null : (
        <View style={styles.card}>
          <AppText variant="title">{t("happening.title")}</AppText>
          {state.running.map((row) => (
            <Button
              kind="quiet"
              key={row.id}
              label={`${t(row.kind === "boost" ? "quests.boost.badge" : "quests.flash.badge")} · ${textIn(row.title, language)}`}
              onPress={() => router.push(`/event/${eventId}/quests`)}
            />
          ))}
        </View>
      )}
      {state.failed ? (
        <>
          <AppText>{t("announcements.loadFailed")}</AppText>
          <Button label={t("common.retry")} onPress={state.retry} />
        </>
      ) : null}
      {state.rows === undefined || state.rows.length === 0 ? null : (
        <>
          <AppText variant="title">{t("announcements.title")}</AppText>
          <AnnouncementRows rows={state.rows} />
          <Button
            kind="quiet"
            label={t("announcements.seeAll")}
            onPress={() => router.push(`/event/${eventId}/announcements`)}
          />
        </>
      )}
    </View>
  );
}

export function AnnouncementsScreen() {
  const { eventId } = useLocalSearchParams<{ eventId: string }>();
  const { t } = useI18n();
  const state = useAnnouncementReads(eventId, true);
  const styles = useThemedStyles(makeStyles);
  return (
    <Screen title={t("announcements.title")}>
      <BackButton />
      <ScrollView contentContainerStyle={styles.list}>
        {state.failed ? (
          <>
            <AppText>{t("announcements.loadFailed")}</AppText>
            <Button label={t("common.retry")} onPress={state.retry} />
          </>
        ) : state.rows === undefined ? (
          <AppText>{t("common.loading")}</AppText>
        ) : state.rows.length === 0 ? (
          <AppText>{t("announcements.empty")}</AppText>
        ) : (
          <AnnouncementRows rows={state.rows} />
        )}
      </ScrollView>
    </Screen>
  );
}

const makeStyles = (theme: Theme) => ({
  list: { gap: theme.spacing.md },
  card: {
    gap: theme.spacing.sm,
    padding: theme.spacing.md,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
  },
});
