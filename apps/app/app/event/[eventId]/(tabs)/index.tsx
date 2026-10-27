import { formatNumber, termFor, type Theme } from "@questify/shared";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Pressable, ScrollView, View } from "react-native";
import { AddEmailCard } from "#src/account/AddEmailCard.tsx";
import { api, keyValueStore } from "#src/api/app-session.ts";
import { Amount, CurrencyIcon } from "#src/components/Amount.tsx";
import { AppText } from "#src/components/AppText.tsx";
import { Button } from "#src/components/Controls.tsx";
import { Avatar } from "#src/components/Avatar.tsx";
import { RehearsalStrip } from "#src/components/RehearsalStrip.tsx";
import { Screen } from "#src/components/Screen.tsx";
import { CountingNumber } from "#src/components/motion.tsx";
import { CommunityBar } from "#src/event/CommunityBar.tsx";
import { countdown, nextBoundary } from "#src/event/countdown.ts";
import { useEvent, useTerms } from "#src/event/EventContext.tsx";
import { EventPill } from "#src/event/EventPill.tsx";
import { goalMessage } from "#src/event/goal.ts";
import { unlockLine } from "#src/event/unlock.ts";
import {
  fetchHome,
  fetchRanking,
  type Home,
  type HomeAnswer,
  type RankingAnswer,
} from "#src/event/home-api.ts";
import { forget } from "#src/event/launch.ts";
import { EXPLAINED_KEY, explainAfterJoin } from "#src/event/location.ts";
import { useLive } from "#src/event/LiveContext.tsx";
import { LocationPrompt, useLocationReader } from "#src/event/LocationEntry.tsx";
import { WinCard } from "#src/event/WinCard.tsx";
import { EventStreakCard } from "#src/streaks/EventStreakCard.tsx";
import { useI18n } from "#src/i18n/provider.tsx";
import { textIn } from "#src/i18n/text.ts";
import { useThemedStyles } from "#src/theme/theme.tsx";

/** How often a waiting request reads Home again (the decision arrives by push once T-501 lands). */
const WAITING_REFRESH_MS = 15_000;

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

/**
 * "The event team answered you" (T-310) while an answer is unseen, whatever the help desk's switch; part of Home's own
 * read, so it shows on every load and refresh (no poll of its own). A tap opens Get help, which marks them seen.
 */
function HelpStrip({ eventId, unread }: Readonly<{ eventId: string; unread: number }>) {
  const { t } = useI18n();
  const styles = useThemedStyles(makeStyles);
  if (unread === 0) {
    return null;
  }
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => router.push(`/event/${eventId}/help`)}
      style={[styles.card, styles.answered]}
    >
      <AppText variant="label">{t("home.helpAnswered")}</AppText>
    </Pressable>
  );
}

/** My rank and the top 3 (FR-802); a tap opens the ranking. Hidden when the ranking is off. */
function RankingCard({ eventId, ranking }: Readonly<{ eventId: string; ranking: RankingAnswer }>) {
  const { t, language } = useI18n();
  const styles = useThemedStyles(makeStyles);
  // Gone: Home's own read is the one place that forgets the event, so the card only steps aside.
  if (ranking.kind !== "ranking" && ranking.kind !== "network") {
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

/** The pinned reward or the next one in reach, and what is left to earn (FR-803, FR-422); a tap opens Rewards. */
function GoalCard({
  eventId,
  goal,
  ended,
  timeZone,
}: Readonly<{ eventId: string; goal: Home["goal"]; ended: boolean; timeZone: string }>) {
  const { t, language } = useI18n();
  const terms = useTerms();
  const styles = useThemedStyles(makeStyles);
  if (goal === null) {
    return null;
  }
  const message = goalMessage(goal, ended);
  // A pinned reward a community goal still locks names the goal, not the points to go (T-306c, CTO 8).
  const unlock =
    goal.communityLock === null ? null : unlockLine(goal.communityLock, language, timeZone);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityHint={t("goal.open")}
      onPress={() => router.navigate({ pathname: "/event/[eventId]/rewards", params: { eventId } })}
      style={styles.card}
    >
      <AppText variant="title">{t(goal.pinned ? "goal.title" : "goal.next")}</AppText>
      <AppText variant="label">{textIn(goal.name, language)}</AppText>
      {unlock !== null ? (
        <AppText muted>{t(unlock.key, unlock.values)}</AppText>
      ) : message === null ? null : (
        <AppText muted>
          {t(message, {
            count: formatNumber(goal.left, language),
            currency: termFor(terms.currency, language, goal.left),
          })}
        </AppText>
      )}
    </Pressable>
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
    return (
      <View style={styles.card} accessibilityLiveRegion="polite">
        <AppText variant="title">
          {t(home.standing.waitlisted ? "eventHome.waitlistTitle" : "eventHome.waitingTitle")}
        </AppText>
        <AppText>
          {t(home.standing.waitlisted ? "eventHome.waitlisted" : "eventHome.pending")}
        </AppText>
      </View>
    );
  }
  if (home.standing.status === "declined") {
    return (
      <View style={styles.card} accessibilityLiveRegion="polite">
        <AppText>{t("eventHome.declined")}</AppText>
        <Button label={t("eventHome.backHome")} onPress={() => router.replace("/home")} />
      </View>
    );
  }
  const { score, balance, pendingPoints, questsDone, questsTotal } = home.standing;
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
      {pendingPoints > 0 ? (
        <AppText muted>
          {t("eventHome.pendingPoints", { points: formatNumber(pendingPoints, language) })}
        </AppText>
      ) : null}
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
  const wasRehearsal = useRef(false);
  const [answer, setAnswer] = useState<HomeAnswer | undefined>(undefined);
  const [ranking, setRanking] = useState<RankingAnswer | undefined>(undefined);
  const load = useCallback(async () => {
    const loaded = await fetchHome(api.session, eventId);
    if (loaded.kind === "gone") {
      await forget(keyValueStore, eventId);
      // A rehearsal account is gone once the event went live (T-211): say so, next to the join box.
      router.replace(
        wasRehearsal.current
          ? { pathname: "/home", params: { notice: "rehearsalEnded" } }
          : "/home",
      );
      return;
    }
    if (loaded.kind === "home") {
      wasRehearsal.current = loaded.home.event.rehearsal;
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
  // A vote from the live poll card pays over this tab, so focus never changes (T-306).
  const { paidCount } = useEvent();
  useEffect(() => {
    if (paidCount > 0) {
      void load();
    }
  }, [paidCount, load]);
  useEffect(() => {
    const watcher = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        void load();
      }
    });
    return () => watcher.remove();
  }, [load]);
  // A request waits for the organizer's word (FR-1819): read it again every 15 seconds until it comes (push is T-501's).
  const waiting = answer?.kind === "home" && answer.home.standing.status === "pending";
  useEffect(() => {
    if (!waiting) {
      return;
    }
    const timer = setInterval(() => void load(), WAITING_REFRESH_MS);
    return () => clearInterval(timer);
  }, [waiting, load]);
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

/**
 * The location explanation right after joining (ADR-208): only when Home was opened from a join (`joined=1`, never at
 * launch), the switch on, an in-person event with a venue pin, the player not asked yet, and once per install.
 * Continue always opens the system prompt.
 */
function useJoinLocationPrompt(home: Home | undefined) {
  const { joined } = useLocalSearchParams<{ joined?: string }>();
  const { locationOn } = useEvent();
  const reader = useLocationReader();
  const [shown, setShown] = useState(false);
  const locationPrompt = home?.event.locationPrompt === true;
  useEffect(() => {
    if (
      joined !== "1" ||
      !locationOn ||
      !locationPrompt ||
      reader === undefined ||
      reader === null
    ) {
      return;
    }
    let current = true;
    void (async () => {
      const explained = (await keyValueStore.getItem(EXPLAINED_KEY).catch(() => null)) !== null;
      const permission = await reader.permission().catch(() => null);
      if (current && explainAfterJoin({ locationOn, locationPrompt, explained, permission })) {
        setShown(true);
      }
    })();
    return () => {
      current = false;
    };
  }, [joined, locationOn, locationPrompt, reader]);
  const proceed = () => {
    setShown(false);
    void keyValueStore.setItem(EXPLAINED_KEY, "1").catch(() => undefined);
    void reader?.ask().catch(() => undefined);
  };
  return { shown, proceed };
}

/** The event's Home (FR-801, FR-802, FR-803, FR-804; T-113, T-213). */
export default function EventHomeScreen() {
  const { t, language } = useI18n();
  const { eventId, rememberName } = useEvent();
  const { answer, ranking, load } = useHome(eventId);
  const prompt = useJoinLocationPrompt(answer?.kind === "home" ? answer.home : undefined);
  const { community } = useLive();
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
      <LocationPrompt visible={prompt.shown} onContinue={prompt.proceed} />
      <ScrollView contentContainerStyle={{ gap: 16 }}>
        <RehearsalStrip shown={home.event.rehearsal} />
        <AddEmailCard />
        <HelpStrip eventId={eventId} unread={home.helpUnread} />
        <CountdownLine event={home.event} />
        <Standing home={home} />
        {home.standing.status === "active" ? <EventStreakCard streak={home.streak} /> : null}
        <WinCard eventId={eventId} win={home.win} timeZone={home.event.timezone} />
        {community === null || home.standing.status !== "active" ? null : (
          <CommunityBar card={community} />
        )}
        {home.standing.status === "active" ? (
          <GoalCard
            eventId={eventId}
            goal={home.goal}
            ended={ended}
            timeZone={home.event.timezone}
          />
        ) : null}
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
  answered: { borderColor: theme.colors.primaryAction },
});
