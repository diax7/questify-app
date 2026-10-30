import type { Theme } from "@questify/shared";
import { router } from "expo-router";
import { Pressable, ScrollView, View } from "react-native";
import { AppText } from "#src/components/AppText.tsx";
import { SponsorMark } from "#src/event/PresentedBy.tsx";
import { useSponsors } from "#src/event/useSponsors.ts";
import { useI18n } from "#src/i18n/provider.tsx";
import { textIn } from "#src/i18n/text.ts";
import { useThemedStyles } from "#src/theme/theme.tsx";

/**
 * Event Home's row of sponsors, in tier order (FR-1307): each opens the Quests tab narrowed to that sponsor's quests.
 * No row at all for an event with no sponsors.
 */
export function SponsorStrip({ eventId }: Readonly<{ eventId: string }>) {
  const { t, language } = useI18n();
  const { sponsors } = useSponsors();
  const styles = useThemedStyles(makeStyles);
  if (sponsors.length === 0) return null;
  return (
    <View style={styles.card}>
      <AppText variant="title">{t("sponsors.strip.title")}</AppText>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.chips}
      >
        {sponsors.map((sponsor) => {
          const name = textIn(sponsor.name, language);
          return (
            <Pressable
              key={sponsor.id}
              accessibilityRole="button"
              accessibilityLabel={t("sponsors.strip.open", { name })}
              onPress={() =>
                router.navigate({
                  pathname: "/event/[eventId]/sponsor",
                  params: { eventId, sponsor: sponsor.id },
                })
              }
              style={styles.chip}
            >
              <SponsorMark sponsor={sponsor} />
              <AppText variant="label">{name}</AppText>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

const makeStyles = (theme: Theme) => ({
  card: {
    gap: theme.spacing.sm,
    padding: theme.spacing.lg,
    borderRadius: theme.radius.lg,
    borderWidth: 2,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  chips: { gap: theme.spacing.sm },
  chip: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: theme.spacing.sm,
    paddingVertical: theme.spacing.sm,
    paddingHorizontal: theme.spacing.md,
    borderRadius: theme.radius.lg,
    borderWidth: 2,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.background,
  },
});
