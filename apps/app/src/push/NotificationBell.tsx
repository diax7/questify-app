import { Ionicons } from "@expo/vector-icons";
import type { Theme } from "@questify/shared";
import { router } from "expo-router";
import type { ReactNode } from "react";
import { Pressable, View } from "react-native";
import { usePlayer } from "#src/auth/player.tsx";
import { useI18n } from "#src/i18n/provider.tsx";
import { useUnread } from "#src/push/unread-store.ts";
import { useTheme, useThemedStyles } from "#src/theme/theme.tsx";

/**
 * The bell with an unread dot (FR-1824, ADR-349 (3)): a tap opens the notification center. The dot is a shape and the
 * label says "new messages", so it never rests on a colour alone. Only a signed-in player has a center.
 */
export function NotificationBell() {
  const { t } = useI18n();
  const { state } = usePlayer();
  const { theme } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const unread = useUnread();
  if (state.status !== "signed_in") return null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t(unread > 0 ? "notifications.bellNew" : "notifications.bell")}
      hitSlop={8}
      onPress={() => router.push("/notifications")}
      style={styles.bell}
    >
      <Ionicons name="notifications-outline" size={26} color={theme.colors.text} />
      {unread > 0 ? <View style={styles.dot} /> : null}
    </Pressable>
  );
}

/** A screen's top row: whatever comes first (the event pill) and the bell at the end. */
export function BellRow({ children }: Readonly<{ children?: ReactNode }>) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.row}>
      <View style={styles.lead}>{children}</View>
      <NotificationBell />
    </View>
  );
}

const makeStyles = (theme: Theme) => ({
  row: { flexDirection: "row" as const, alignItems: "center" as const, gap: theme.spacing.md },
  lead: { flex: 1, alignItems: "flex-start" as const },
  bell: {
    width: 44,
    height: 44,
    alignItems: "center" as const,
    justifyContent: "center" as const,
  },
  dot: {
    position: "absolute" as const,
    top: 8,
    end: 8,
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: theme.colors.primaryAction,
    borderWidth: 1,
    borderColor: theme.colors.background,
  },
});
