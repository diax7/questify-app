import type { Theme } from "@questify/shared";
import { router } from "expo-router";
import { View } from "react-native";
import { Button } from "#src/components/Controls.tsx";
import { useI18n } from "#src/i18n/provider.tsx";
import { useUnread } from "#src/push/unread-store.ts";
import { useThemedStyles } from "#src/theme/theme.tsx";

/** Profile → Notifications (FR-1824): opens the center, with a dot while a message waits unread. */
export function NotificationsRow() {
  const { t } = useI18n();
  const styles = useThemedStyles(makeStyles);
  const unread = useUnread();
  return (
    <View style={styles.row}>
      {unread > 0 ? (
        <View accessible accessibilityLabel={t("notifications.bellNew")} style={styles.dot} />
      ) : null}
      <View style={styles.grow}>
        <Button
          kind="quiet"
          label={t("notifications.title")}
          onPress={() => router.push("/notifications")}
        />
      </View>
    </View>
  );
}

const makeStyles = (theme: Theme) => ({
  row: { flexDirection: "row" as const, alignItems: "center" as const, gap: theme.spacing.md },
  grow: { flex: 1 },
  dot: { width: 10, height: 10, borderRadius: 5, backgroundColor: theme.colors.primaryAction },
});
