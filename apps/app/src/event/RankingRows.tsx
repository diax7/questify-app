import { formatNumber, termFor, type Theme } from "@questify/shared";
import { router } from "expo-router";
import { Pressable, View } from "react-native";
import { isolatedLtr } from "#src/auth/sign-in-api.ts";
import { CurrencyIcon } from "#src/components/Amount.tsx";
import { AppText } from "#src/components/AppText.tsx";
import { Avatar } from "#src/components/Avatar.tsx";
import { useTerms } from "#src/event/EventContext.tsx";
import type { ShownRow } from "#src/event/ranking.ts";
import { useI18n } from "#src/i18n/provider.tsx";
import { useThemedStyles } from "#src/theme/theme.tsx";

/** The words a screen reader says for a row: the place, who, the score when the row has one, and the title worn. */
export function useRowLabel(row: ShownRow): string {
  const { t, language } = useI18n();
  const terms = useTerms();
  const title = row.equipment?.title == null ? "" : `، ${row.equipment.title.name[language]}`;
  if (row.score === null) {
    const key = row.isMe ? "ranking.rowLabelMeRankOnly" : "ranking.rowLabelRankOnly";
    return `${t(key, { rank: row.rank, username: row.username })}${title}`;
  }
  const score = formatNumber(row.score, language);
  const currency = termFor(terms.currency, language, row.score);
  const label = row.isMe
    ? t("ranking.rowLabelMe", { rank: row.rank, score, currency })
    : t("ranking.rowLabel", { rank: row.rank, username: row.username, score, currency });
  return `${label}${title}`;
}

export function openPlayer(username: string): void {
  router.push({ pathname: "/player/[username]", params: { username } });
}

export function RankBadge({ rank }: Readonly<{ rank: number }>) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={[styles.badge, rank <= 3 ? styles.badgeTop : null]}>
      <AppText variant="label" numberOfLines={1} adjustsFontSizeToFit>
        {rank}
      </AppText>
    </View>
  );
}

/** One place in the list: the place, the face, the player, and the score unless the event shows places only. */
export function RankingRow({ row, height }: Readonly<{ row: ShownRow; height: number }>) {
  const { t, language } = useI18n();
  const styles = useThemedStyles(makeStyles);
  const label = useRowLabel(row);
  return (
    <Pressable
      accessible
      accessibilityRole="button"
      onPress={() => openPlayer(row.username)}
      accessibilityLabel={label}
      style={[styles.row, { height }, row.isMe ? styles.mine : null]}
    >
      <RankBadge rank={row.rank} />
      <Avatar
        name={row.avatar}
        username={row.username}
        size={Math.max(0, height - 8)}
        equipment={row.equipment}
      />
      <AppText
        numberOfLines={1}
        adjustsFontSizeToFit
        // A username is Latin: it reads left to right inside an Arabic row, so "@" stays in front.
        style={[styles.grow, { writingDirection: "ltr" }]}
      >
        {isolatedLtr(`@${row.username}`)}
        {row.equipment?.title == null ? "" : ` · ${row.equipment.title.name[language]}`}
      </AppText>
      {row.isMe ? <AppText variant="label">{t("ranking.you")}</AppText> : null}
      {row.score === null ? null : (
        <>
          <CurrencyIcon size={20} />
          <AppText variant="label" numberOfLines={1}>
            {formatNumber(row.score, language)}
          </AppText>
        </>
      )}
    </Pressable>
  );
}

const makeStyles = (theme: Theme) => ({
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
