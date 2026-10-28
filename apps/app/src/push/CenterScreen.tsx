import type { NotificationItem, Theme } from "@questify/shared";
import { router, useLocalSearchParams } from "expo-router";
import { Pressable, ScrollView, View } from "react-native";
import { AppText } from "#src/components/AppText.tsx";
import { BackButton } from "#src/components/BackButton.tsx";
import { Button } from "#src/components/Controls.tsx";
import { Screen } from "#src/components/Screen.tsx";
import { useI18n } from "#src/i18n/provider.tsx";
import { joinRouteOf, rowRoute, stampOf } from "#src/push/center.ts";
import { useCenter, type Center } from "#src/push/use-center.ts";
import { useUnread } from "#src/push/unread-store.ts";
import { useThemedStyles } from "#src/theme/theme.tsx";

/**
 * One message. The unread dot is a shape and the screen reader hears "Unread" first, so it never rests on colour. A
 * promotional row carries its way out, to Settings → Offers and notifications (FR-1114, Apple 4.5.4); an invitation also
 * carries "See the event", the join screen by the event's public code (ADR-356 (6)).
 */
function Row({
  item,
  highlighted,
  onPress,
}: Readonly<{ item: NotificationItem; highlighted: boolean; onPress: () => void }>) {
  const { t, language } = useI18n();
  const styles = useThemedStyles(makeStyles);
  const stamp = stampOf(item.createdAt, language);
  const join = joinRouteOf(item);
  const label = [item.read ? "" : t("notifications.unread"), item.title, item.body, stamp]
    .filter((part) => part !== "")
    .join(". ");
  return (
    <View style={[styles.row, highlighted && styles.highlighted]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        onPress={onPress}
        style={styles.main}
      >
        <View style={item.read ? styles.noDot : styles.dot} />
        <View style={styles.text}>
          <AppText variant="label">{item.title}</AppText>
          <AppText>{item.body}</AppText>
          {stamp === "" ? null : <AppText muted>{stamp}</AppText>}
        </View>
      </Pressable>
      {join === null ? null : (
        <Button
          label={t("notifications.seeEvent")}
          onPress={() => {
            onPress();
            router.push(join);
          }}
        />
      )}
      {item.optOut ? (
        <Button
          kind="quiet"
          label={t("notifications.optOut")}
          onPress={() => router.push("/settings/notifications")}
        />
      ) : null}
    </View>
  );
}

/** Why there are no rows to show: the first page is on its way, it failed (with a retry), or the center is empty. */
function CenterNotice({ center }: Readonly<{ center: Center }>) {
  const { t } = useI18n();
  if (center.failed) {
    return (
      <>
        <AppText accessibilityRole="alert">{t("notifications.loadFailed")}</AppText>
        <Button kind="quiet" label={t("common.retry")} onPress={center.retry} />
      </>
    );
  }
  if (center.rows === null) return <AppText muted>{t("common.loading")}</AppText>;
  return center.rows.length === 0 ? <AppText muted>{t("notifications.empty")}</AppText> : null;
}

/**
 * The notification center (P16, FR-1104, FR-1824): every message Questify sent the player, newest first, read and unread,
 * whether or not a push reached the phone. A tap marks the row read and opens the screen its kind leads to; a
 * promotional row stays here with its opt-out. `row` (from a tapped promotional push) marks the row to look at.
 */
export function CenterScreen() {
  const { t } = useI18n();
  const { row } = useLocalSearchParams<{ row?: string }>();
  const center = useCenter();
  const unread = useUnread();
  const rows = center.rows;

  const open = (item: NotificationItem) => {
    if (!item.read) center.markRead([item.id]);
    const route = rowRoute(item);
    if (route.kind === "route") router.push(route.href);
  };

  return (
    <Screen title={t("notifications.title")} header={<BackButton />}>
      <ScrollView contentContainerStyle={{ gap: 12 }}>
        <CenterNotice center={center} />
        {rows !== null && unread > 0 ? (
          <Button
            kind="quiet"
            label={t("notifications.markAll")}
            onPress={() => center.markRead(null)}
          />
        ) : null}
        {(rows ?? []).map((item) => (
          <Row
            key={item.id}
            item={item}
            highlighted={row === String(item.id)}
            onPress={() => open(item)}
          />
        ))}
        {center.more === null ? null : (
          <Button kind="quiet" label={t("notifications.more")} onPress={center.more} />
        )}
      </ScrollView>
    </Screen>
  );
}

const makeStyles = (theme: Theme) => ({
  row: {
    gap: theme.spacing.sm,
    padding: theme.spacing.md,
    borderRadius: theme.radius.md,
    borderWidth: 2,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  highlighted: { borderColor: theme.colors.primaryAction },
  main: { flexDirection: "row" as const, gap: theme.spacing.md, alignItems: "flex-start" as const },
  text: { flex: 1, gap: theme.spacing.xs },
  dot: {
    width: 10,
    height: 10,
    marginTop: 6,
    borderRadius: 5,
    backgroundColor: theme.colors.primaryAction,
  },
  noDot: { width: 10, height: 10, marginTop: 6 },
});
