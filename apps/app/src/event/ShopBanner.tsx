import { formatEventTime, type Theme } from "@questify/shared";
import { View } from "react-native";
import { AppText } from "#src/components/AppText.tsx";
import type { ShopLine } from "#src/event/shop-window.ts";
import { useI18n } from "#src/i18n/provider.tsx";
import { useThemedStyles } from "#src/theme/theme.tsx";

/**
 * Home's line about the shop after the event (FR-750, ADR-338): when the open shop closes, with the desk's hours when
 * they end first (items and experiences stop there), or that it closed. A date and time in the event's zone, never a
 * countdown and never loss copy (ADR-300).
 */
export function ShopBanner({
  line,
  timeZone,
}: Readonly<{ line: ShopLine | null; timeZone: string }>) {
  const { t, language } = useI18n();
  const styles = useThemedStyles(makeStyles);
  if (line === null) {
    return null;
  }
  const when = (instant: string) => formatEventTime(new Date(instant), timeZone, language);
  return (
    <View style={styles.card} accessibilityLiveRegion="polite">
      {line.kind === "closed" ? (
        <AppText variant="label">
          {line.closesAt === null
            ? t("shop.closed")
            : t("shopWindow.closedOn", { date: when(line.closesAt) })}
        </AppText>
      ) : (
        <>
          <AppText variant="label">
            {t("shopWindow.openUntil", { date: when(line.closesAt) })}
          </AppText>
          {line.desk?.kind === "until" ? (
            <AppText muted>{t("shopWindow.deskUntil", { date: when(line.desk.endsAt) })}</AppText>
          ) : null}
          {line.desk?.kind === "stopped" ? (
            <AppText muted>{t("shopWindow.deskStopped")}</AppText>
          ) : null}
        </>
      )}
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
});
