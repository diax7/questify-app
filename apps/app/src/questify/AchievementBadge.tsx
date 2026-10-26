import type { AchievementTier, ColorRole, Theme } from "@questify/shared";
import { Image, View, type ImageSourcePropType } from "react-native";
import { AppText } from "#src/components/AppText.tsx";
import { useTheme, useThemedStyles } from "#src/theme/theme.tsx";

/** The five badges of the shipped achievement set, trimmed and reduced to 192 px (`docs/design/assets/achievements`). */
const ART: Readonly<Record<string, ImageSourcePropType>> = {
  "ach-first-steps": require("#assets/achievements/ach-first-steps.png"),
  "ach-collector": require("#assets/achievements/ach-collector.png"),
  "ach-swift": require("#assets/achievements/ach-swift.png"),
  "ach-summit": require("#assets/achievements/ach-summit.png"),
  "ach-social": require("#assets/achievements/ach-social.png"),
};
const PADLOCK: ImageSourcePropType = require("#assets/icons/padlock.png");

const RING: Readonly<Record<AchievementTier, ColorRole>> = {
  bronze: "tierBronze",
  silver: "tierSilver",
  gold: "tierGold",
};

const artFor = (visualKey: string): ImageSourcePropType | null =>
  Object.prototype.hasOwnProperty.call(ART, visualKey) ? (ART[visualKey] ?? null) : null;

/**
 * One achievement's badge: the shipped art inside a ring in the tier's colour. An unearned one is a dark silhouette
 * with a padlock, and its ring is plain (FR-708). A badge this app version has no art for shows the name's first
 * letter. Decorative: the text beside it, or the label the caller sets on the row, names the achievement and tier.
 */
export function AchievementBadge({
  visualKey,
  tier,
  letter,
  size,
}: Readonly<{ visualKey: string; tier: AchievementTier | null; letter: string; size: number }>) {
  const styles = useThemedStyles(makeStyles);
  const { theme } = useTheme();
  const art = artFor(visualKey);
  const earned = tier !== null;
  const picture = size * 0.68;
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        styles.ring,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          borderColor: earned ? theme.colors[RING[tier]] : theme.colors.border,
        },
      ]}
    >
      {art === null ? (
        <AppText variant="title">{letter}</AppText>
      ) : (
        <Image
          source={art}
          resizeMode="contain"
          style={[
            { width: picture, height: picture },
            earned ? null : { tintColor: theme.colors.text, opacity: 0.22 },
          ]}
        />
      )}
      {earned ? null : (
        <Image
          source={PADLOCK}
          resizeMode="contain"
          style={[styles.padlock, { width: size * 0.34, height: size * 0.34 }]}
        />
      )}
    </View>
  );
}

const makeStyles = (theme: Theme) => ({
  ring: {
    alignItems: "center" as const,
    justifyContent: "center" as const,
    borderWidth: 4,
    backgroundColor: theme.colors.surface,
  },
  padlock: { position: "absolute" as const },
});
