import type { Theme } from "@questify/shared";
import { useEffect, useSyncExternalStore } from "react";
import { Modal, Pressable, View } from "react-native";
import { AppText } from "#src/components/AppText.tsx";
import { Button } from "#src/components/Controls.tsx";
import { useI18n } from "#src/i18n/provider.tsx";
import { dialogs } from "#src/platform/dialog-queue.ts";
import { dialogPresses } from "#src/platform/dialog-presses.ts";
import { useThemedStyles } from "#src/theme/theme.tsx";

/**
 * The browser's confirmation dialog (T-803, FOLLOWUPS): the title, the message and every button of an `Alert.alert` call,
 * drawn by the app, so it cannot be blocked the way `window.confirm` can. A tap on a button runs its handler and closes
 * the dialog; the shade and the back key take the cancel button (a dialog with none just closes). Rendered once, by the
 * root layout.
 */
export function AlertHost() {
  const { t, rtl } = useI18n();
  const styles = useThemedStyles(makeStyles);
  useEffect(() => dialogs.mountHost(), []);
  const request = useSyncExternalStore(dialogs.subscribe, dialogs.current, dialogs.current);
  if (request === undefined) {
    return null;
  }
  const { buttons, dismiss } = dialogPresses(request.buttons, t("common.close"));
  const close = (button: (typeof buttons)[number] | undefined): void => {
    dialogs.dismiss();
    button?.onPress?.();
  };
  return (
    <Modal visible transparent animationType="fade" onRequestClose={() => close(dismiss)}>
      <View style={styles.backdrop}>
        <Pressable
          accessible={false}
          importantForAccessibility="no"
          onPress={() => close(dismiss)}
          style={styles.shade}
        />
        <View accessibilityRole="alert" style={[styles.dialog, { direction: rtl ? "rtl" : "ltr" }]}>
          <AppText variant="title" accessibilityRole="header">
            {request.title}
          </AppText>
          {request.message === undefined || request.message === "" ? null : (
            <AppText>{request.message}</AppText>
          )}
          {buttons.map((button, index) => (
            <Button
              key={`${index}-${button.text}`}
              kind={button.style === "cancel" ? "quiet" : "primary"}
              label={button.text}
              onPress={() => close(button)}
            />
          ))}
        </View>
      </View>
    </Modal>
  );
}

const makeStyles = (theme: Theme) => ({
  backdrop: { flex: 1, justifyContent: "center" as const, padding: theme.spacing.xl },
  shade: {
    position: "absolute" as const,
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: theme.colors.text,
    opacity: 0.4,
  },
  dialog: {
    gap: theme.spacing.md,
    padding: theme.spacing.xl,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.background,
  },
});
