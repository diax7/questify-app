import { termFor, type Theme } from "@questify/shared";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { AppState, Pressable, View, type LayoutChangeEvent } from "react-native";
import { api, keyValueStore } from "#src/api/app-session.ts";
import { AppText } from "#src/components/AppText.tsx";
import { BackButton } from "#src/components/BackButton.tsx";
import { Button } from "#src/components/Controls.tsx";
import { Screen } from "#src/components/Screen.tsx";
import { useEvent, useTerms } from "#src/event/EventContext.tsx";
import { fetchRanking, type Ranking, type RankingScope } from "#src/event/home-api.ts";
import { forget } from "#src/event/launch.ts";
import { podiumFit, rankingRows, rowHeight } from "#src/event/ranking.ts";
import { Podium } from "#src/event/RankingPodium.tsx";
import { RankingRow } from "#src/event/RankingRows.tsx";
import { useI18n } from "#src/i18n/provider.tsx";
import { useThemedStyles } from "#src/theme/theme.tsx";

const GAP = 6;
const REFRESH_MS = 15_000;

type Loaded =
  | Readonly<{ kind: "loading" | "off" | "failed" }>
  | Readonly<{ kind: "ranking"; ranking: Ranking; stale: boolean }>;

/**
 * Reads the ranking on focus, on return to the front, and every 15 seconds while it is on screen (until the live stream,
 * T-5xx), one read at a time. A refresh that fails keeps the last good list and says so. Today's ranking (T-216) that
 * is no longer offered falls back to the whole event's. A read that answers after the player switched scope is dropped.
 */
function useRanking(eventId: string) {
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });
  const [scope, setScope] = useState<RankingScope>("event");
  const [today, setToday] = useState(false);
  const inFlight = useRef<RankingScope | null>(null);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const left = useRef(false);
  const load = useCallback(async () => {
    if (inFlight.current === scope) {
      return;
    }
    inFlight.current = scope;
    const answer = await fetchRanking(api.session, eventId, scope).finally(() => {
      if (inFlight.current === scope) {
        inFlight.current = null;
      }
    });
    if (left.current || scopeRef.current !== scope) {
      return;
    }
    if (answer.kind === "gone") {
      left.current = true;
      await forget(keyValueStore, eventId);
      router.replace("/home");
      return;
    }
    if (answer.kind === "signed_out") {
      left.current = true;
      router.replace("/home");
      return;
    }
    if (answer.kind === "today_off") {
      setToday(false);
      setLoaded({ kind: "loading" });
      setScope("event");
      return;
    }
    if (answer.kind === "ranking") {
      setToday(answer.ranking.today);
    }
    setLoaded((current) => {
      if (answer.kind === "ranking") {
        return { kind: "ranking", ranking: answer.ranking, stale: false };
      }
      if (answer.kind === "off") {
        return { kind: "off" };
      }
      return current.kind === "ranking" ? { ...current, stale: true } : { kind: "failed" };
    });
  }, [eventId, scope]);

  useFocusEffect(
    useCallback(() => {
      left.current = false;
      void load();
      let timer = setInterval(() => void load(), REFRESH_MS);
      const watcher = AppState.addEventListener("change", (state) => {
        clearInterval(timer);
        if (state === "active") {
          void load();
          timer = setInterval(() => void load(), REFRESH_MS);
        }
      });
      return () => {
        left.current = true;
        clearInterval(timer);
        watcher.remove();
      };
    }, [load]),
  );
  const choose = (next: RankingScope) => {
    if (next !== scope) {
      setLoaded({ kind: "loading" });
      setScope(next);
    }
  };
  return { loaded, load, scope, choose, today };
}

/** Whole event / Today (FR-610): shown while the event has a today's ranking. */
function ScopeTabs({
  scope,
  onChoose,
}: Readonly<{ scope: RankingScope; onChoose: (scope: RankingScope) => void }>) {
  const { t } = useI18n();
  const styles = useThemedStyles(makeStyles);
  return (
    <View accessibilityRole="tablist" style={styles.tabs}>
      {(["event", "today"] as const).map((choice) => (
        <Pressable
          key={choice}
          accessibilityRole="tab"
          accessibilityState={{ selected: choice === scope }}
          onPress={() => onChoose(choice)}
          style={[styles.tab, choice === scope && styles.chosen]}
        >
          <AppText variant="label">
            {t(choice === "event" ? "ranking.scopeEvent" : "ranking.scopeToday")}
          </AppText>
        </Pressable>
      ))}
    </View>
  );
}

/** The screen before there is a list: loading, switched off, or a failed read with Retry. */
function UnreadyRanking({
  kind,
  retry,
}: Readonly<{ kind: "loading" | "off" | "failed"; retry: () => void }>) {
  const { t } = useI18n();
  return (
    <>
      {kind === "loading" ? <AppText muted>{t("common.loading")}</AppText> : null}
      {kind === "off" ? <AppText>{t("ranking.off")}</AppText> : null}
      {kind === "failed" ? (
        <>
          <AppText accessibilityRole="alert">{t("eventHome.rankingFailed")}</AppText>
          <Button label={t("common.retry")} onPress={retry} />
        </>
      ) : null}
    </>
  );
}

/** The notes above the list: a refresh that failed, an empty list, and the player having no place yet. */
function RankingNotes({
  stale,
  empty,
  unranked,
  scope,
  currency,
}: Readonly<{
  stale: boolean;
  empty: boolean;
  unranked: boolean;
  scope: RankingScope;
  currency: string;
}>) {
  const { t } = useI18n();
  return (
    <>
      {stale ? <AppText muted>{t("ranking.refreshFailed")}</AppText> : null}
      {empty ? (
        <AppText muted>
          {scope === "today" ? t("ranking.todayEmpty", { currency }) : t("ranking.empty")}
        </AppText>
      ) : null}
      {unranked && !empty ? <AppText muted>{t("eventHome.noRank")}</AppText> : null}
    </>
  );
}

/**
 * The event's ranking (FR-601 to FR-605): the top 10, and the player's own row as an 11th when they are ranked lower,
 * always on one screen. Rows share the measured height, so they shrink rather than scroll (FR-603). Public profile
 * details only (FR-604); no player can hide from it (FR-605).
 */
export default function RankingScreen() {
  const { t, language } = useI18n();
  const { eventId, layout } = useEvent();
  const terms = useTerms();
  const styles = useThemedStyles(makeStyles);
  const { loaded, load, scope, choose, today } = useRanking(eventId);
  const [available, setAvailable] = useState(0);
  const measure = (event: LayoutChangeEvent) => setAvailable(event.nativeEvent.layout.height);

  const tabs = today ? <ScopeTabs scope={scope} onChoose={choose} /> : null;
  if (loaded.kind !== "ranking") {
    return (
      <Screen title={t("nav.ranking")} header={<BackButton />}>
        {tabs}
        <UnreadyRanking kind={loaded.kind} retry={() => void load()} />
      </Screen>
    );
  }
  const rows = rankingRows(loaded.ranking);
  return (
    <Screen title={t("nav.ranking")} header={<BackButton />}>
      {tabs}
      <RankingNotes
        stale={loaded.stale}
        empty={rows.length === 0}
        unranked={loaded.ranking.me === null}
        scope={scope}
        currency={termFor(terms.currency, language, 2)}
      />
      <View style={styles.list} onLayout={measure}>
        {available > 0 ? (
          <RankingBody
            rows={rows}
            layout={layout.looks.ranking.layout}
            available={available}
            withScores={loaded.ranking.scores}
          />
        ) : null}
      </View>
    </Screen>
  );
}

/**
 * The rows in the event's layout (FR-1832). The list shares the measured height among every row; the podium takes its share
 * for the top three and the rows below it share the rest, so either one fits the screen with no scrolling. An empty ranking
 * draws nothing. An unknown layout is the list (the reader already fell back to it).
 */
function RankingBody({
  rows,
  layout,
  available,
  withScores,
}: Readonly<{
  rows: ReturnType<typeof rankingRows>;
  layout: "list" | "podium";
  available: number;
  withScores: boolean;
}>) {
  if (layout === "podium" && rows.length > 0) {
    const below = rows.slice(3);
    const fit = podiumFit(available, below.length, GAP);
    return (
      <View style={{ gap: GAP }}>
        <Podium top={rows.slice(0, 3)} height={fit.podium} withScores={withScores} />
        {below.map((row) => (
          <RankingRow key={row.key} row={row} height={fit.row} />
        ))}
      </View>
    );
  }
  const height = rowHeight(available, rows.length, GAP);
  return rows.map((row) => <RankingRow key={row.key} row={row} height={height} />);
}

const makeStyles = (theme: Theme) => ({
  // A margin, not padding: the measured height must be the rows' own space.
  list: { flex: 1, gap: GAP, marginBottom: theme.spacing.lg },
  tabs: { flexDirection: "row" as const, gap: theme.spacing.sm },
  tab: {
    flex: 1,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    minHeight: 44,
    paddingVertical: theme.spacing.xs,
    borderRadius: theme.radius.md,
    borderWidth: 2,
    borderColor: theme.colors.border,
  },
  chosen: { borderColor: theme.colors.highlight },
});
