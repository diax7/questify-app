import type { Theme } from "@questify/shared";
import { View } from "react-native";
import { AppText } from "#src/components/AppText.tsx";
import { useI18n } from "#src/i18n/provider.tsx";
import { useOptionalOperator } from "#src/operator/OperatorContext.tsx";
import { useThemedStyles } from "#src/theme/theme.tsx";

/**
 * "Practice: nothing is saved" (ADR-250, OPERATOR_MODE §3.4): shown at the top of every staff-mode screen while
 * practice mode is on, in words as well as colour. Outside staff mode there is no operator, and nothing shows.
 */
export function PracticeStrip() {
  const operator = useOptionalOperator();
  const { t } = useI18n();
  const styles = useThemedStyles(makeStyles);
  if (operator?.practice !== true) {
    return null;
  }
  return (
    <View accessibilityRole="summary" style={styles.strip}>
      <AppText variant="label" style={styles.stripText}>
        {t("operator.practice.strip")}
      </AppText>
    </View>
  );
}

const makeStyles = (theme: Theme) => ({
  // The station's orange, as a border: the words carry the meaning, never the colour alone.
  strip: {
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    borderRadius: theme.radius.md,
    borderWidth: 2,
    borderColor: "#C25E00",
    backgroundColor: theme.colors.surface,
  },
  stripText: { textAlign: "center" as const },
});
