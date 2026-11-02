import { formatNumber, shownName, termFor, type Theme } from "@questify/shared";
import { router } from "expo-router";
import { Pressable, View, type StyleProp, type TextStyle } from "react-native";
import { CurrencyIcon } from "#src/components/Amount.tsx";
import { AppText } from "#src/components/AppText.tsx";
import { Avatar } from "#src/components/Avatar.tsx";
import { useTerms } from "#src/event/EventContext.tsx";
import { PlayerName } from "#src/event/PlayerName.tsx";
import type { ShownRow } from "#src/event/ranking.ts";
import { useI18n } from "#src/i18n/provider.tsx";
import { useThemedStyles } from "#src/theme/theme.tsx";

/** The words a screen reader says for a row: the place, who, the score when the row has one, and the title worn. */
export function useRowLabel(row: ShownRow): string {
  const { t, language } = useI18n();
  const terms = useTerms();
  if (row.hidden) {
    return t("ranking.rowLabelHidden", { rank: row.rank });
  }
  const title = row.equipment?.title == null ? "" : `، ${row.equipment.title.name[language]}`;
  const shown = shownName(row.fullName, row.names);
  const who =
    shown.fullName === null
      ? row.username
      : shown.showUsername
        ? `${shown.fullName} (@${row.username})`
        : shown.fullName;
  if (row.score === null) {
    const key = row.isMe ? "ranking.rowLabelMeRankOnly" : "ranking.rowLabelRankOnly";
    return `${t(key, { rank: row.rank, username: who })}${title}`;
  }
  const score = formatNumber(row.score, language);
  const currency = termFor(terms.currency, language, row.score);
  const label = row.isMe
    ? t("ranking.rowLabelMe", { rank: row.rank, score, currency })
    : t("ranking.rowLabel", { rank: row.rank, username: who, score, currency });
  return `${label}${title}`;
}

export function openPlayer(username: string): void {
  router.push({ pathname: "/player/[username]", params: { username } });
}

/** What a row opens: the player's profile, or nothing for a player the reader blocked. */
export const pressOf = (row: ShownRow): (() => void) | undefined =>
  row.hidden ? undefined : () => openPlayer(row.username);

/** The name in a row: the player's, or "Hidden player" for one the reader blocked (FR-1415). */
export function RowName({
  row,
  variant,
  suffix,
  style,
}: Readonly<{
  row: ShownRow;
  variant?: "label";
  suffix?: string;
  style?: StyleProp<TextStyle>;
}>) {
  const { t } = useI18n();
  if (row.hidden) {
    return (
      <AppText {...(variant === undefined ? {} : { variant })} numberOfLines={1} style={style}>
        {t("ranking.hiddenPlayer")}
      </AppText>
    );
  }
  return (
    <PlayerName
      {...(variant === undefined ? {} : { variant })}
      username={row.username}
      fullName={row.fullName}
      names={row.names}
      {...(suffix === undefined ? {} : { suffix })}
      style={style}
    />
  );
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
      accessibilityRole={row.hidden ? "text" : "button"}
      onPress={pressOf(row)}
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
      <RowName
        row={row}
        suffix={row.equipment?.title == null ? "" : ` · ${row.equipment.title.name[language]}`}
        style={styles.grow}
      />
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
