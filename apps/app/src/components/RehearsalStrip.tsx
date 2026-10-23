import type { Theme } from "@questify/shared";
import { View } from "react-native";
import { AppText } from "#src/components/AppText.tsx";
import { useI18n } from "#src/i18n/provider.tsx";
import { useThemedStyles } from "#src/theme/theme.tsx";

/**
 * The strip at the top of a rehearsal (ADR-080, OPERATOR_MODE §2.4): "Rehearsal: everything is erased at go-live."
 * Nothing else changes on the screen.
 */
export function RehearsalStrip({ shown }: Readonly<{ shown: boolean }>) {
  const { t } = useI18n();
  const styles = useThemedStyles(makeStyles);
  if (!shown) {
    return null;
  }
  return (
    <View accessibilityRole="summary" style={styles.strip}>
      <AppText variant="label">{t("rehearsal.strip")}</AppText>
    </View>
  );
}

const makeStyles = (theme: Theme) => ({
  strip: {
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    borderRadius: theme.radius.md,
    borderWidth: 2,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
});
