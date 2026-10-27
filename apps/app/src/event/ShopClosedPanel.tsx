import { formatEventTime, termFor, type Theme } from "@questify/shared";
import { View } from "react-native";
import { AppText } from "#src/components/AppText.tsx";
import { useTerms } from "#src/event/EventContext.tsx";
import { useI18n } from "#src/i18n/provider.tsx";
import { useThemedStyles } from "#src/theme/theme.tsx";

/**
 * What the Rewards tab says once the shop has closed (FR-750, ADR-337, ADR-338): the date, that the event's balance can
 * no longer be redeemed, and what stays (the points, the rank and the passport stamp). The catalog is not offered.
 */
export function ShopClosedPanel({
  closesAt,
  timeZone,
}: Readonly<{ closesAt: string | null; timeZone: string }>) {
  const { t, language } = useI18n();
  const terms = useTerms();
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.card} accessibilityRole="alert">
      <AppText variant="label">
        {closesAt === null
          ? t("shop.closed")
          : t("shopWindow.closedOn", {
              date: formatEventTime(new Date(closesAt), timeZone, language),
            })}
      </AppText>
      <AppText>{t("shop.closedBody", { currency: termFor(terms.currency, language, 2) })}</AppText>
    </View>
  );
}

const makeStyles = (theme: Theme) => ({
  card: {
    gap: theme.spacing.sm,
    padding: theme.spacing.md,
    borderRadius: theme.radius.md,
    borderWidth: 2,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
});
