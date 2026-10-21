import { formatNumber, termFor, type Theme } from "@questify/shared";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { AppState, View, type LayoutChangeEvent } from "react-native";
import { api, keyValueStore } from "#src/api/app-session.ts";
import { CurrencyIcon } from "#src/components/Amount.tsx";
import { AppText } from "#src/components/AppText.tsx";
import { Avatar } from "#src/components/Avatar.tsx";
import { BackButton } from "#src/components/BackButton.tsx";
import { Button } from "#src/components/Controls.tsx";
import { Screen } from "#src/components/Screen.tsx";
import { useEvent, useTerms } from "#src/event/EventContext.tsx";
import { fetchRanking, type Ranking } from "#src/event/home-api.ts";
import { forget } from "#src/event/launch.ts";
import { rankingRows, rowHeight, type ShownRow } from "#src/event/ranking.ts";
import { useI18n } from "#src/i18n/provider.tsx";
import { useThemedStyles } from "#src/theme/theme.tsx";

const GAP = 6;
const REFRESH_MS = 15_000;

type Loaded =
  | Readonly<{ kind: "loading" | "off" | "failed" }>
  | Readonly<{ kind: "ranking"; ranking: Ranking; stale: boolean }>;

/**
 * Reads the ranking on focus, on return to the front, and every 15 seconds while it is on screen (until the live stream,
 * T-5xx), one read at a time. A refresh that fails keeps the last good list and says so.
 */
function useRanking(eventId: string) {
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });
  const inFlight = useRef(false);
  const left = useRef(false);
  const load = useCallback(async () => {
    if (inFlight.current) {
      return;
    }
    inFlight.current = true;
    const answer = await fetchRanking(api.session, eventId).finally(() => {
      inFlight.current = false;
    });
    if (left.current) {
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
    setLoaded((current) => {
      if (answer.kind === "ranking") {
        return { kind: "ranking", ranking: answer.ranking, stale: false };
      }
      if (answer.kind === "off") {
        return { kind: "off" };
      }
      return current.kind === "ranking" ? { ...current, stale: true } : { kind: "failed" };
    });
  }, [eventId]);

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
  return { loaded, load };
}

function RankBadge({ rank }: Readonly<{ rank: number }>) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={[styles.badge, rank <= 3 ? styles.badgeTop : null]}>
      <AppText variant="label" numberOfLines={1} adjustsFontSizeToFit>
        {rank}
      </AppText>
    </View>
  );
}

function Row({ row, height }: Readonly<{ row: ShownRow; height: number }>) {
  const { t, language } = useI18n();
  const terms = useTerms();
  const styles = useThemedStyles(makeStyles);
  const score = formatNumber(row.score, language);
  const currency = termFor(terms.currency, language, row.score);
  const label = row.isMe
    ? t("ranking.rowLabelMe", { rank: row.rank, score, currency })
    : t("ranking.rowLabel", { rank: row.rank, username: row.username, score, currency });
  return (
    <View
      accessible
      accessibilityLabel={label}
      style={[styles.row, { height }, row.isMe ? styles.mine : null]}
    >
      <RankBadge rank={row.rank} />
      <Avatar name={row.avatar} username={row.username} size={Math.max(0, height - 8)} />
      <AppText
        numberOfLines={1}
        adjustsFontSizeToFit
        // A username is Latin: it reads left to right inside an Arabic row, so "@" stays in front.
        style={[styles.grow, { writingDirection: "ltr" }]}
      >
        @{row.username}
      </AppText>
      {row.isMe ? <AppText variant="label">{t("ranking.you")}</AppText> : null}
      <CurrencyIcon size={20} />
      <AppText variant="label" numberOfLines={1}>
        {score}
      </AppText>
    </View>
  );
}

/**
 * The event's ranking (FR-601 to FR-605): the top 10, and the player's own row as an 11th when they are ranked lower,
 * always on one screen. Rows share the measured height, so they shrink rather than scroll (FR-603). Public profile
 * details only (FR-604); no player can hide from it (FR-605).
 */
export default function RankingScreen() {
  const { t } = useI18n();
  const { eventId } = useEvent();
  const styles = useThemedStyles(makeStyles);
  const { loaded, load } = useRanking(eventId);
  const [available, setAvailable] = useState(0);
  const measure = (event: LayoutChangeEvent) => setAvailable(event.nativeEvent.layout.height);

  if (loaded.kind !== "ranking") {
    return (
      <Screen title={t("nav.ranking")} header={<BackButton />}>
        {loaded.kind === "loading" ? <AppText muted>{t("common.loading")}</AppText> : null}
        {loaded.kind === "off" ? <AppText>{t("ranking.off")}</AppText> : null}
        {loaded.kind === "failed" ? (
          <>
            <AppText accessibilityRole="alert">{t("eventHome.rankingFailed")}</AppText>
            <Button label={t("common.retry")} onPress={() => void load()} />
          </>
        ) : null}
      </Screen>
    );
  }
  const rows = rankingRows(loaded.ranking);
  const height = rowHeight(available, rows.length, GAP);
  return (
    <Screen title={t("nav.ranking")} header={<BackButton />}>
      {loaded.stale ? <AppText muted>{t("ranking.refreshFailed")}</AppText> : null}
      {rows.length === 0 ? <AppText muted>{t("ranking.empty")}</AppText> : null}
      {loaded.ranking.me === null && rows.length > 0 ? (
        <AppText muted>{t("eventHome.noRank")}</AppText>
      ) : null}
      <View style={styles.list} onLayout={measure}>
        {available > 0 ? rows.map((row) => <Row key={row.key} row={row} height={height} />) : null}
      </View>
    </Screen>
  );
}

const makeStyles = (theme: Theme) => ({
  // A margin, not padding: the measured height must be the rows' own space.
  list: { flex: 1, gap: GAP, marginBottom: theme.spacing.lg },
  row: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: theme.spacing.sm,
    paddingHorizontal: theme.spacing.sm,
    borderRadius: theme.radius.md,
    borderWidth: 2,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  mine: { borderColor: theme.colors.highlight, borderWidth: 3 },
  badge: {
    minWidth: 28,
    paddingHorizontal: theme.spacing.xs,
    alignItems: "center" as const,
    borderRadius: theme.radius.pill,
    borderWidth: 2,
    borderColor: theme.colors.highlight,
  },
  badgeTop: { backgroundColor: theme.colors.highlight },
  grow: { flex: 1 },
});
