import type { Theme } from "@questify/shared";
import { router } from "expo-router";
import { Pressable } from "react-native";
import { AppText } from "#src/components/AppText.tsx";
import { useI18n } from "#src/i18n/provider.tsx";
import { useThemedStyles } from "#src/theme/theme.tsx";

/** Home's "Your recap" card once the event has ended (FR-752): a tap opens the recap and its share. */
export function RecapEntry({ eventId }: Readonly<{ eventId: string }>) {
  const { t } = useI18n();
  const styles = useThemedStyles(makeStyles);
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => router.push(`/event/${eventId}/recap`)}
      style={styles.card}
    >
      <AppText variant="title">{t("recap.title")}</AppText>
    </Pressable>
  );
}

const makeStyles = (theme: Theme) => ({
  card: {
    gap: theme.spacing.sm,
    padding: theme.spacing.lg,
    borderRadius: theme.radius.lg,
    borderWidth: 2,
    borderColor: theme.colors.primaryAction,
    backgroundColor: theme.colors.surface,
  },
});
