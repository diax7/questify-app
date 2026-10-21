import { formatNumber, termFor, type Theme } from "@questify/shared";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { AppState, Pressable, ScrollView, View } from "react-native";
import { api, keyValueStore } from "#src/api/app-session.ts";
import { Amount, CurrencyIcon } from "#src/components/Amount.tsx";
import { AppText } from "#src/components/AppText.tsx";
import { Button } from "#src/components/Controls.tsx";
import { Avatar } from "#src/components/Avatar.tsx";
import { Screen } from "#src/components/Screen.tsx";
import { CountingNumber } from "#src/components/motion.tsx";
import { countdown, nextBoundary } from "#src/event/countdown.ts";
import { useEvent, useTerms } from "#src/event/EventContext.tsx";
import { EventPill } from "#src/event/EventPill.tsx";
import {
  fetchHome,
  fetchRanking,
  type Home,
  type HomeAnswer,
  type RankingAnswer,
} from "#src/event/home-api.ts";
import { forget } from "#src/event/launch.ts";
import { useI18n } from "#src/i18n/provider.tsx";
import { textIn } from "#src/i18n/text.ts";
import { useThemedStyles } from "#src/theme/theme.tsx";

/** The phone's clock, ticking each half minute so the countdown's words stay current. */
function useNow(): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function CountdownLine({ event }: Readonly<{ event: Home["event"] }>) {
  const { t, language } = useI18n();
  const now = useNow();
  const shown = countdown(event, now, language);
  if (shown === null) {
    return null;
  }
  if (shown.kind === "ended") {
    return <AppText variant="label">{t("eventHome.ended")}</AppText>;
  }
  const soon = shown.kind === "starts" ? "eventHome.startsSoon" : "eventHome.endsSoon";
  const inSpan = shown.kind === "starts" ? "eventHome.startsIn" : "eventHome.endsIn";
  return (
    <AppText variant="label">
      {shown.span === null ? t(soon) : t(inSpan, { span: shown.span })}
    </AppText>
  );
}

/** My rank and the top 3 (FR-802); a tap opens the ranking. Hidden when the ranking is off. */
function RankingCard({ eventId, ranking }: Readonly<{ eventId: string; ranking: RankingAnswer }>) {
  const { t, language } = useI18n();
  const styles = useThemedStyles(makeStyles);
  // Gone: Home's own read is the one place that forgets the event, so the card only steps aside.
  if (ranking.kind === "off" || ranking.kind === "signed_out" || ranking.kind === "gone") {
    return null;
  }
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => router.push(`/event/${eventId}/ranking`)}
      style={styles.card}
    >
      <AppText variant="title">{t("nav.ranking")}</AppText>
      {ranking.kind === "network" ? (
        <AppText muted>{t("eventHome.rankingFailed")}</AppText>
      ) : (
        <>
          <AppText variant="label">
            {ranking.ranking.me === null
              ? t("eventHome.noRank")
              : t("eventHome.yourRank", { rank: ranking.ranking.me.rank })}
          </AppText>
          {ranking.ranking.rows.slice(0, 3).map((row) => (
            <View key={`${row.rank}:${row.username}`} style={styles.rankRow}>
              <AppText>{row.rank}</AppText>
              <Avatar name={row.avatar} username={row.username} size={28} />
              <AppText numberOfLines={1} style={[styles.grow, { writingDirection: "ltr" }]}>
                @{row.username}
              </AppText>
              <AppText>{formatNumber(row.score, language)}</AppText>
            </View>
          ))}
        </>
      )}
    </Pressable>
  );
}

function UpNextCard({ eventId, upNext }: Readonly<{ eventId: string; upNext: Home["upNext"] }>) {
  const { t, language } = useI18n();
  const styles = useThemedStyles(makeStyles);
  if (upNext === null) {
    return null;
  }
  return (
    <View style={styles.card}>
      <AppText variant="title">{t("eventHome.upNext")}</AppText>
      <AppText variant="label">{textIn(upNext.title, language)}</AppText>
      <Amount amount={formatNumber(upNext.points, language)} form="labelled" muted />
      <Button
        label={t("eventHome.go")}
        onPress={() =>
          router.navigate({
            pathname: "/event/[eventId]/quests",
            params: { eventId, quest: upNext.questId },
          })
        }
      />
    </View>
  );
}

/** The points and balance (FR-403), counting to each new value; another event's Home mounts new counters. */
function Counter({ id, value }: Readonly<{ id: string; value: number }>) {
  const { language } = useI18n();
  return (
    <CountingNumber
      key={id}
      variant="title"
      value={value}
      format={(shown) => formatNumber(shown, language)}
    />
  );
}

function Standing({ home }: Readonly<{ home: Home }>) {
  const { t, language } = useI18n();
  const terms = useTerms();
  const styles = useThemedStyles(makeStyles);
  if (home.standing.status === "pending") {
    return <AppText>{t("eventHome.pending")}</AppText>;
  }
  const { score, balance, questsDone, questsTotal } = home.standing;
  const eventId = home.event.id;
  return (
    <View style={styles.card}>
      <View style={styles.rankRow}>
        <CurrencyIcon size={24} />
        <AppText style={styles.grow}>
          {t("eventHome.points", { currency: termFor(terms.currency, language) })}
        </AppText>
        <Counter id={`${eventId}:score`} value={score} />
      </View>
      <View style={styles.rankRow}>
        <AppText style={styles.grow}>{t("eventHome.balance")}</AppText>
        <Counter id={`${eventId}:balance`} value={balance} />
      </View>
      <AppText muted>{t("eventHome.progress", { done: questsDone, total: questsTotal })}</AppText>
    </View>
  );
}

/**
 * Reads Home on focus, when the app comes back to the front (points after a scan), and just after the next boundary,
 * so the status changes on the server's word. A definite 403 or 404 forgets the event and goes to Questify home; a
 * network failure forgets nothing.
 */
function useHome(eventId: string) {
  const [answer, setAnswer] = useState<HomeAnswer | undefined>(undefined);
  const [ranking, setRanking] = useState<RankingAnswer | undefined>(undefined);
  const load = useCallback(async () => {
    const loaded = await fetchHome(api.session, eventId);
    if (loaded.kind === "gone") {
      await forget(keyValueStore, eventId);
      router.replace("/home");
      return;
    }
    if (loaded.kind === "signed_out") {
      router.replace("/home");
      return;
    }
    setAnswer((current) =>
      loaded.kind === "network" && current?.kind === "home" ? current : loaded,
    );
    if (loaded.kind === "home" && loaded.home.standing.status === "active") {
      setRanking(
        loaded.home.rankingOn ? await fetchRanking(api.session, eventId) : { kind: "off" },
      );
    }
  }, [eventId]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );
  useEffect(() => {
    const watcher = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        void load();
      }
    });
    return () => watcher.remove();
  }, [load]);
  const event = answer?.kind === "home" ? answer.home.event : undefined;
  useEffect(() => {
    const delay = event === undefined ? null : nextBoundary(event, Date.now());
    if (delay === null) {
      return;
    }
    const timer = setTimeout(() => void load(), delay);
    return () => clearTimeout(timer);
  }, [event, load]);
  return { answer, ranking, load };
}

/** The event's Home (FR-801, FR-802, FR-804; T-113). */
export default function EventHomeScreen() {
  const { t, language } = useI18n();
  const { eventId, rememberName } = useEvent();
  const { answer, ranking, load } = useHome(eventId);
  const loadedName = answer?.kind === "home" ? textIn(answer.home.event.name, language) : "";
  useEffect(() => {
    if (loadedName !== "") {
      rememberName(loadedName);
    }
  }, [loadedName, rememberName]);

  if (answer === undefined || answer.kind !== "home") {
    return (
      <Screen title={t("nav.home")} header={<EventPill />}>
        {answer === undefined ? (
          <AppText muted>{t("common.loading")}</AppText>
        ) : (
          <>
            <AppText accessibilityRole="alert">{t("eventHome.loadFailed")}</AppText>
            <Button label={t("common.retry")} onPress={() => void load()} />
          </>
        )}
      </Screen>
    );
  }
  const { home } = answer;
  const ended = home.event.statusNow === "ended" || home.event.statusNow === "archived";
  return (
    <Screen title={textIn(home.event.name, language)} header={<EventPill />}>
      <ScrollView contentContainerStyle={{ gap: 16 }}>
        <CountdownLine event={home.event} />
        <Standing home={home} />
        {home.standing.status === "active" && ranking !== undefined ? (
          <RankingCard eventId={eventId} ranking={ranking} />
        ) : null}
        {ended ? null : <UpNextCard eventId={eventId} upNext={home.upNext} />}
        {home.standing.status === "active" ? (
          <Button
            kind="quiet"
            label={t("history.title")}
            onPress={() => router.push(`/event/${eventId}/history`)}
          />
        ) : null}
        <Button
          kind="quiet"
          label={t("eventHome.info")}
          onPress={() => router.push(`/event/${eventId}/info`)}
        />
      </ScrollView>
    </Screen>
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
  rankRow: { flexDirection: "row" as const, gap: theme.spacing.md, alignItems: "center" as const },
  grow: { flex: 1 },
});
