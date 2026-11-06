import { formatNumber, shownName, termFor, type Language, type Theme } from "@questify/shared";
import { router } from "expo-router";
import { Pressable, View, type StyleProp, type TextStyle } from "react-native";
import { CurrencyIcon } from "#src/components/Amount.tsx";
import { AppText } from "#src/components/AppText.tsx";
import { Avatar } from "#src/components/Avatar.tsx";
import { useEvent, useTerms } from "#src/event/EventContext.tsx";
import { PlayerName } from "#src/event/PlayerName.tsx";
import { withLevel, type ShownRow } from "#src/event/ranking.ts";
import { useI18n } from "#src/i18n/provider.tsx";
import type { Translate } from "#src/i18n/words.ts";
import { LevelBadge } from "#src/questify/LevelBadge.tsx";
import { useThemedStyles } from "#src/theme/theme.tsx";

/** The level badge beside a row's name; a shorter row draws it smaller so it never fills the row. */
const MAX_BADGE = 26;

/** Who a row names aloud: the username, or the full name the event shows (with the username when it shows both). */
function spokenName(row: ShownRow): string {
  const shown = shownName(row.fullName, row.names);
  if (shown.fullName === null) {
    return row.username;
  }
  return shown.showUsername ? `${shown.fullName} (@${row.username})` : shown.fullName;
}

/** The words a screen reader says for a row: the place, who, the score when the row has one, and the title worn. */
function rowLabel(
  row: ShownRow,
  t: Translate,
  language: Language,
  terms: ReturnType<typeof useTerms>,
): string {
  if (row.hidden) {
    return t("ranking.rowLabelHidden", { rank: row.rank });
  }
  const title = row.equipment?.title == null ? "" : `، ${row.equipment.title.name[language]}`;
  const who = spokenName(row);
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

/** What a row is called aloud, ending with the player's level when the row has one (T-404d). */
export function useRowLabel(row: ShownRow): string {
  const { t, language } = useI18n();
  const terms = useTerms();
  return withLevel(rowLabel(row, t, language, terms), row.level, t, language);
}

/** The player's profile; from an event's ranking it carries the event, so a report of the name reaches its team. */
export function openPlayer(username: string, eventId?: string): void {
  router.push({
    pathname: "/player/[username]",
    params: eventId === undefined ? { username } : { username, event: eventId },
  });
}

/** What a row opens: the player's profile, or nothing for a player the reader blocked. */
export const pressOf = (row: ShownRow, eventId?: string): (() => void) | undefined =>
  row.hidden ? undefined : () => openPlayer(row.username, eventId);

/** The name in a row: the player's, or "Hidden name" for one the reader blocked (FR-1415). */
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
  const { eventId } = useEvent();
  return (
    <Pressable
      accessible
      accessibilityRole={row.hidden ? "text" : "button"}
      onPress={pressOf(row, eventId)}
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
      <View style={styles.who}>
        <RowName
          row={row}
          suffix={row.equipment?.title == null ? "" : ` · ${row.equipment.title.name[language]}`}
          style={styles.shrink}
        />
        {row.level === undefined ? null : (
          <LevelBadge level={row.level} size={Math.max(0, Math.min(MAX_BADGE, height - 4))} />
        )}
      </View>
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
  who: {
    flex: 1,
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: theme.spacing.xs,
  },
  shrink: { flexShrink: 1 },
});
