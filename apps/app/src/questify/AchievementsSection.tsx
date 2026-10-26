import type { Achievement, AchievementTier, Theme } from "@questify/shared";
import { View } from "react-native";
import { api } from "#src/api/app-session.ts";
import { AppText } from "#src/components/AppText.tsx";
import { Button } from "#src/components/Controls.tsx";
import { useI18n } from "#src/i18n/provider.tsx";
import { AchievementBadge } from "#src/questify/AchievementBadge.tsx";
import { useQuestifySync } from "#src/questify/QuestifySyncProvider.tsx";
import { fetchAchievements } from "#src/questify/questify-api.ts";
import { useRead } from "#src/questify/use-read.ts";
import { useThemedStyles } from "#src/theme/theme.tsx";

const BADGE = 64;

type TileProps = Readonly<{
  achievement: Achievement;
  /** The player's own profile also says how far the next tier is; another player's never does. */
  withProgress: boolean;
}>;

function Tile({ achievement, withProgress }: TileProps) {
  const { t, language } = useI18n();
  const styles = useThemedStyles(makeStyles);
  const name = achievement.name[language];
  const { tier, next } = achievement;
  const tierName = tier === null ? null : t(`achievements.tier.${tier}`);
  const nextText =
    withProgress && next !== null
      ? t("achievements.next", {
          tier: t(`achievements.tier.${next.tier}`),
          progress: Math.min(achievement.progress, next.target),
          target: next.target,
        })
      : null;
  const badgeLabel =
    tierName === null
      ? t("achievements.locked", { name })
      : t("achievements.badge", { name, tier: tierName });
  // The label replaces the tile's children for a screen reader, so the progress line is part of it.
  const label = nextText === null ? badgeLabel : `${badgeLabel}. ${nextText}`;
  return (
    <View accessible accessibilityLabel={label} style={styles.tile}>
      <AchievementBadge
        visualKey={achievement.visualKey}
        tier={tier}
        letter={Array.from(name)[0] ?? "?"}
        size={BADGE}
      />
      <AppText variant="label" style={styles.center}>
        {name}
      </AppText>
      {tierName === null ? null : (
        <AppText muted style={styles.center}>
          {tierName}
        </AppText>
      )}
      {nextText === null ? null : (
        <AppText muted style={styles.center}>
          {nextText}
        </AppText>
      )}
      {withProgress && tier === "gold" && next === null ? (
        <AppText muted style={styles.center}>
          {t("achievements.topTier")}
        </AppText>
      ) : null}
    </View>
  );
}

function Failed({ retry }: Readonly<{ retry: () => void }>) {
  const { t } = useI18n();
  return (
    <>
      <AppText accessibilityRole="alert">{t("achievements.failed")}</AppText>
      <Button kind="quiet" label={t("common.retry")} onPress={retry} />
    </>
  );
}

/** Your achievements (FR-707, FR-708): five badges, earned ones in their tier's ring, the rest as silhouettes. */
export function OwnAchievements() {
  const { t } = useI18n();
  const { version } = useQuestifySync();
  const styles = useThemedStyles(makeStyles);
  const read = useRead(() => fetchAchievements(api.session), [version]);
  return (
    <View style={styles.section}>
      <AppText variant="title">{t("achievements.title")}</AppText>
      {read.failed ? <Failed retry={read.retry} /> : null}
      {read.data === null ? null : (
        <View style={styles.grid}>
          {read.data.map((achievement) => (
            <Tile key={achievement.id} achievement={achievement} withProgress />
          ))}
        </View>
      )}
    </View>
  );
}

/**
 * Another player's achievements: the server sends tiers only, so names and art come from the viewer's own catalog
 * (the same five for everyone) and the progress it holds is the viewer's, never shown here.
 */
export function PublicAchievements({
  tiers,
}: Readonly<{ tiers: ReadonlyArray<Readonly<{ id: string; tier: AchievementTier | null }>> }>) {
  const { t } = useI18n();
  const styles = useThemedStyles(makeStyles);
  const read = useRead(() => fetchAchievements(api.session), []);
  const shown = (read.data ?? []).flatMap((entry) => {
    const theirs = tiers.find((item) => item.id === entry.id);
    return theirs === undefined ? [] : [{ ...entry, tier: theirs.tier, next: null }];
  });
  return (
    <View style={styles.section}>
      <AppText variant="title">{t("achievements.title")}</AppText>
      {read.failed ? <Failed retry={read.retry} /> : null}
      <View style={styles.grid}>
        {shown.map((achievement) => (
          <Tile key={achievement.id} achievement={achievement} withProgress={false} />
        ))}
      </View>
    </View>
  );
}

const makeStyles = (theme: Theme) => ({
  section: { gap: theme.spacing.md },
  grid: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: theme.spacing.lg },
  center: { textAlign: "center" as const },
  tile: { width: 104, alignItems: "center" as const, gap: theme.spacing.xs },
});
