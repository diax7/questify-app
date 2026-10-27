import {
  formatNumber,
  type Language,
  type QuestifyRanking,
  type QuestifyRankingScope,
  type Theme,
} from "@questify/shared";
import { router } from "expo-router";
import { useState } from "react";
import { Pressable, View } from "react-native";
import { api } from "#src/api/app-session.ts";
import { isolatedLtr } from "#src/auth/sign-in-api.ts";
import { AppText } from "#src/components/AppText.tsx";
import { Avatar } from "#src/components/Avatar.tsx";
import { Button } from "#src/components/Controls.tsx";
import { MAX_ROW_HEIGHT } from "#src/event/ranking.ts";
import {
  fetchQuestifyRanking,
  questifyRankingRows,
  type QuestifyRankingAnswer,
  type ShownQuestifyRow,
} from "#src/explore/ranking-api.ts";
import { useI18n } from "#src/i18n/provider.tsx";
import { useRead } from "#src/questify/use-read.ts";
import { useThemedStyles } from "#src/theme/theme.tsx";

const SCOPES: readonly QuestifyRankingScope[] = ["lifetime", "month"];
const SCOPE_TEXT = {
  lifetime: "explore.ranking.lifetime",
  month: "explore.ranking.month",
} as const;

function ScopeTabs({
  scope,
  onChoose,
}: Readonly<{ scope: QuestifyRankingScope; onChoose: (scope: QuestifyRankingScope) => void }>) {
  const { t } = useI18n();
  const styles = useThemedStyles(makeStyles);
  return (
    <View accessibilityRole="tablist" style={styles.tabs}>
      {SCOPES.map((choice) => (
        <Pressable
          key={choice}
          accessibilityRole="tab"
          accessibilityState={{ selected: choice === scope }}
          onPress={() => onChoose(choice)}
          style={[styles.tab, choice === scope && styles.chosen]}
        >
          <AppText variant="label">{t(SCOPE_TEXT[choice])}</AppText>
        </Pressable>
      ))}
    </View>
  );
}

/** The spoken row: rank, name, XP and level, with the equipped title when there is one (each language punctuates it). */
function rowLabel(
  row: ShownQuestifyRow,
  language: Language,
  t: ReturnType<typeof useI18n>["t"],
): string {
  const params = {
    rank: row.rank,
    username: row.username,
    xp: formatNumber(row.xp, language),
    level: row.level,
  };
  const title = row.equipment.title?.name[language];
  const key =
    `explore.ranking.rowLabel${row.isMe ? "Me" : ""}${title === undefined ? "" : "Titled"}` as const;
  return t(key, title === undefined ? params : { ...params, title });
}

function Row({ row }: Readonly<{ row: ShownQuestifyRow }>) {
  const { t, language } = useI18n();
  const styles = useThemedStyles(makeStyles);
  const xp = formatNumber(row.xp, language);
  const title = row.equipment.title?.name[language];
  const label = rowLabel(row, language, t);
  return (
    <Pressable
      accessible
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={() =>
        router.push({ pathname: "/player/[username]", params: { username: row.username } })
      }
      style={[styles.row, row.isMe ? styles.mine : null]}
    >
      <View style={[styles.badge, row.rank <= 3 ? styles.badgeTop : null]}>
        <AppText variant="label" numberOfLines={1} adjustsFontSizeToFit>
          {row.rank}
        </AppText>
      </View>
      <Avatar
        name={row.avatar}
        username={row.username}
        size={MAX_ROW_HEIGHT - 8}
        equipment={row.equipment}
      />
      <AppText
        numberOfLines={1}
        adjustsFontSizeToFit
        // A username is Latin: it reads left to right inside an Arabic row, so "@" stays in front.
        style={[styles.grow, { writingDirection: "ltr" }]}
      >
        {isolatedLtr(`@${row.username}`)}
        {title === undefined ? "" : ` · ${title}`}
      </AppText>
      {row.isMe ? <AppText variant="label">{t("ranking.you")}</AppText> : null}
      <AppText variant="label" numberOfLines={1}>
        {t("explore.xp", { xp })}
      </AppText>
    </Pressable>
  );
}

function BoardFailure({ hasBoard, retry }: Readonly<{ hasBoard: boolean; retry: () => void }>) {
  const { t } = useI18n();
  return (
    <>
      <AppText accessibilityRole="alert">
        {t(hasBoard ? "ranking.refreshFailed" : "explore.ranking.failed")}
      </AppText>
      <Button kind="quiet" label={t("common.retry")} onPress={retry} />
    </>
  );
}

function BoardNotices({
  ranking,
  rowCount,
  failed,
  retry,
}: Readonly<{
  ranking: QuestifyRanking | null;
  rowCount: number;
  failed: boolean;
  retry: () => void;
}>) {
  const { t } = useI18n();
  if (failed) {
    return <BoardFailure hasBoard={ranking !== null} retry={retry} />;
  }
  if (ranking === null) {
    return <AppText muted>{t("common.loading")}</AppText>;
  }
  if (rowCount === 0) {
    return <AppText muted>{t("explore.ranking.empty")}</AppText>;
  }
  return ranking.me === null ? <AppText muted>{t("explore.ranking.noRank")}</AppText> : null;
}

function Board({
  answer,
  scope,
  failed,
  retry,
}: Readonly<{
  answer: Extract<QuestifyRankingAnswer, { kind: "ranking" }> | null;
  scope: QuestifyRankingScope;
  failed: boolean;
  retry: () => void;
}>) {
  const styles = useThemedStyles(makeStyles);
  // Switching tabs keeps the last answer until the new one arrives: it is shown only for its own scope.
  const ranking = answer?.ranking.scope === scope ? answer.ranking : null;
  const rows = ranking === null ? [] : questifyRankingRows(ranking);
  return (
    <>
      <BoardNotices ranking={ranking} rowCount={rows.length} failed={failed} retry={retry} />
      <View style={styles.list}>
        {rows.map((row) => (
          <Row key={row.key} row={row} />
        ))}
      </View>
    </>
  );
}

/**
 * The Questify-wide ranking by XP on Explore (FR-611): All time and This month, the top 10 and the player's own place
 * as an 11th row. Gems are never part of it. Nothing is shown while the platform has the ranking switched off.
 */
export function QuestifyRanking() {
  const { t } = useI18n();
  const [scope, setScope] = useState<QuestifyRankingScope>("lifetime");
  const read = useRead(async () => {
    const answer = await fetchQuestifyRanking(api.session, scope);
    return answer.kind === "failed" ? null : answer;
  }, [scope]);
  const answer = read.data;
  if (answer?.kind === "off" || answer?.kind === "signed_out") {
    return null;
  }
  return (
    <>
      <AppText variant="title" accessibilityRole="header">
        {t("explore.ranking.title")}
      </AppText>
      <ScopeTabs scope={scope} onChoose={setScope} />
      <Board answer={answer ?? null} scope={scope} failed={read.failed} retry={read.retry} />
    </>
  );
}

const makeStyles = (theme: Theme) => ({
  list: { gap: 6 },
  row: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: theme.spacing.sm,
    height: MAX_ROW_HEIGHT,
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
