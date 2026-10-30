import type { ColorRole, MemberSponsor, SponsorTier, Theme } from "@questify/shared";
import { View } from "react-native";
import { AppText } from "#src/components/AppText.tsx";
import { useI18n } from "#src/i18n/provider.tsx";
import { textIn } from "#src/i18n/text.ts";
import { useTheme, useThemedStyles } from "#src/theme/theme.tsx";

/** The colour that rings a sponsor's mark, by tier. */
const TIER_COLOR: Readonly<Record<SponsorTier, ColorRole>> = {
  platinum: "highlight",
  gold: "tierGold",
  silver: "tierSilver",
  bronze: "tierBronze",
  partner: "border",
};

/**
 * A sponsor's mark: its first letter in a ring of its tier's colour. It stands where the sponsor's logo will go once
 * logos can be uploaded (T-507b); it is decoration, the name beside it carries the meaning.
 */
export function SponsorMark({ sponsor }: Readonly<{ sponsor: MemberSponsor }>) {
  const { language } = useI18n();
  const styles = useThemedStyles(makeStyles);
  const { theme } = useTheme();
  const initial = Array.from(textIn(sponsor.name, language))[0]?.toLocaleUpperCase() ?? "";
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.mark, { borderColor: theme.colors[TIER_COLOR[sponsor.tier]] }]}
    >
      <AppText variant="label">{initial}</AppText>
    </View>
  );
}

/** "Presented by {sponsor}" with the sponsor's mark, on a quest, a category or a reward that has one (FR-1303). */
export function PresentedBy({ sponsor }: Readonly<{ sponsor: MemberSponsor | undefined }>) {
  const { t, language } = useI18n();
  const styles = useThemedStyles(makeStyles);
  if (sponsor === undefined) return null;
  const line = t("sponsors.presentedBy", { name: textIn(sponsor.name, language) });
  return (
    <View style={styles.row}>
      <SponsorMark sponsor={sponsor} />
      <AppText muted>{line}</AppText>
    </View>
  );
}

const makeStyles = (theme: Theme) => ({
  row: { flexDirection: "row" as const, alignItems: "center" as const, gap: theme.spacing.sm },
  mark: {
    alignItems: "center" as const,
    justifyContent: "center" as const,
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 2,
    backgroundColor: theme.colors.surface,
  },
});
