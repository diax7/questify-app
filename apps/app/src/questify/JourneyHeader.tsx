import { Ionicons } from "@expo/vector-icons";
import { formatNumber, type LevelRewards, type ProfileItem, type Theme } from "@questify/shared";
import { View } from "react-native";
import type { Me } from "#src/auth/player.tsx";
import { AppText } from "#src/components/AppText.tsx";
import { useI18n } from "#src/i18n/provider.tsx";
import { ItemPreview } from "#src/questify/ItemPreview.tsx";
import { levelOfRewards, xpLine } from "#src/questify/journey.ts";
import { levelProgress } from "#src/questify/level.ts";
import { useTheme, useThemedStyles } from "#src/theme/theme.tsx";

/**
 * The wooden plaque at the top of Journey: the level in a gold medallion, its title, and the parchment bar to the next
 * level with "1,400 of 2,000 XP" under it. The same progress rule as the Profile's level card.
 */
export function LevelPlaque({ rewards }: Readonly<{ rewards: LevelRewards }>) {
  const { t, language } = useI18n();
  const styles = useThemedStyles(makeStyles);
  const progress = levelProgress(levelOfRewards(rewards));
  const { number, title } = rewards.level;
  return (
    <View style={styles.plaque}>
      <View
        accessible
        accessibilityRole="header"
        accessibilityLabel={`${t("level.number", { level: number })}, ${title[language]}`}
        style={styles.top}
      >
        <View style={styles.medallion}>
          <AppText variant="display" style={styles.medallionText}>
            {String(number)}
          </AppText>
        </View>
        <View style={styles.grow}>
          <AppText variant="label" style={styles.onWood}>
            {t("level.number", { level: number })}
          </AppText>
          <AppText variant="title" style={styles.onWood} numberOfLines={2}>
            {title[language]}
          </AppText>
        </View>
      </View>
      <View
        accessible
        accessibilityRole="progressbar"
        accessibilityLabel={t("level.progress")}
        accessibilityValue={{ min: 0, max: 100, now: Math.round(progress * 100) }}
        style={styles.track}
      >
        <View style={[styles.fill, { width: `${progress * 100}%` }]} />
      </View>
      <AppText variant="label" style={styles.onWood}>
        {xpLine(t, rewards, (value) => formatNumber(value, language))}
      </AppText>
    </View>
  );
}

/**
 * The next level's item as it will look on the player's own avatar or name plate, locked, with the level it comes at, on
 * a gold-edged parchment card. Nothing here is for sale: a level opens it.
 */
export function NextRewardCard({
  level,
  item,
  me,
}: Readonly<{ level: number; item: ProfileItem; me: Me }>) {
  const { t, language } = useI18n();
  const { theme } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const name = item.name[language];
  return (
    <View
      accessible
      accessibilityLabel={`${t("locker.next", { item: name })}, ${t("level.number", { level })}`}
      style={styles.next}
    >
      <ItemPreview item={item} me={me} size={64} locked />
      <View style={styles.grow}>
        <AppText variant="label">{t("level.number", { level })}</AppText>
        <AppText variant="title" numberOfLines={2}>
          {name}
        </AppText>
      </View>
      <Ionicons name="gift-outline" size={28} color={theme.colors.tierGold} />
    </View>
  );
}

const makeStyles = (theme: Theme) => ({
  plaque: {
    gap: theme.spacing.md,
    padding: theme.spacing.lg,
    borderRadius: theme.radius.lg,
    borderWidth: 3,
    borderColor: theme.colors.highlight,
    backgroundColor: theme.colors.navigationBar,
  },
  top: { flexDirection: "row" as const, alignItems: "center" as const, gap: theme.spacing.md },
  medallion: {
    width: 64,
    height: 64,
    borderRadius: theme.radius.pill,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    borderWidth: 4,
    borderColor: theme.colors.background,
    backgroundColor: theme.colors.navigationActive,
  },
  medallionText: { color: theme.colors.text },
  grow: { flex: 1, gap: 2 },
  onWood: { color: theme.colors.background },
  track: {
    height: 14,
    borderRadius: theme.radius.md,
    overflow: "hidden" as const,
    flexDirection: "row" as const,
    backgroundColor: theme.colors.background,
  },
  fill: { height: 14, backgroundColor: theme.colors.navigationActive },
  next: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: theme.spacing.md,
    padding: theme.spacing.md,
    borderRadius: theme.radius.lg,
    borderWidth: 3,
    borderColor: theme.colors.tierGold,
    backgroundColor: theme.colors.surface,
  },
});
