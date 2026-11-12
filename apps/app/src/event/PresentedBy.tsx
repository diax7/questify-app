import type {
  ColorRole,
  MemberSponsor,
  PresentedBySponsor,
  SponsorTier,
  Theme,
} from "@questify/shared";
import { View } from "react-native";
import { AppText } from "#src/components/AppText.tsx";
import { useEventIdOrNull } from "#src/event/EventContext.tsx";
import { OrganizerImage } from "#src/event/OrganizerImage.tsx";
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
 * A sponsor's mark: its logo (T-507b) in a ring of its tier's colour, or its first letter while it has none or the logo
 * cannot be drawn. It is decoration: the name beside it carries the meaning.
 */
export function SponsorMark({ sponsor }: Readonly<{ sponsor: PresentedBySponsor }>) {
  const { language } = useI18n();
  const styles = useThemedStyles(makeStyles);
  const { theme } = useTheme();
  const current = useEventIdOrNull();
  const name = textIn(sponsor.name, language);
  const initial = Array.from(name)[0]?.toLocaleUpperCase() ?? "";
  const letter = <AppText variant="label">{initial}</AppText>;
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.mark, { borderColor: theme.colors[TIER_COLOR[sponsor.tier]] }]}
    >
      {sponsor.logo === undefined || sponsor.logo === null ? (
        letter
      ) : (
        <OrganizerImage
          eventId={sponsor.eventId ?? current}
          imageId={sponsor.logo}
          label={name}
          style={styles.logo}
          resizeMode="contain"
          fallback={letter}
        />
      )}
    </View>
  );
}

/**
 * "Presented by {sponsor}" with the sponsor's mark, on a quest, a category, a reward or a souvenir that has one
 * (FR-1303).
 */
export function PresentedBy({ sponsor }: Readonly<{ sponsor: PresentedBySponsor | undefined }>) {
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

/**
 * A sponsor's banner over the category it presents (T-507b, FR-1303), 3:1; nothing while it has none or the picture
 * cannot be drawn. The "presented by" line under it names the sponsor.
 */
export function SponsorBanner({ sponsor }: Readonly<{ sponsor: MemberSponsor | undefined }>) {
  const { language } = useI18n();
  const eventId = useEventIdOrNull();
  const styles = useThemedStyles(makeStyles);
  if (sponsor?.banner === undefined || sponsor.banner === null) return null;
  return (
    <OrganizerImage
      eventId={eventId}
      imageId={sponsor.banner}
      label={textIn(sponsor.name, language)}
      style={styles.banner}
    />
  );
}

const makeStyles = (theme: Theme) => ({
  banner: { width: "100%" as const, aspectRatio: 3, borderRadius: theme.radius.md },
  row: { flexDirection: "row" as const, alignItems: "center" as const, gap: theme.spacing.sm },
  logo: { width: 22, height: 22, borderRadius: 11 },
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
