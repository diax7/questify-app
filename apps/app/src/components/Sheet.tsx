import type { Theme } from "@questify/shared";
import { useEffect, type ReactNode } from "react";
import { Modal, Pressable, ScrollView, View } from "react-native";
import { AppText } from "#src/components/AppText.tsx";
import { Button } from "#src/components/Controls.tsx";
import { sheetOpened } from "#src/components/sheet-count.ts";
import { useI18n } from "#src/i18n/provider.tsx";
import { useThemedStyles } from "#src/theme/theme.tsx";

/**
 * A sheet from the bottom with a title and a Close button (or `closeLabel`'s words); a tap on the shade or the back
 * button closes it too. While visible it counts as open, so the live poll card never opens over it (T-306).
 */
export function Sheet({
  visible,
  title,
  onClose,
  closeLabel,
  children,
}: Readonly<{
  visible: boolean;
  title: string;
  onClose: () => void;
  closeLabel?: string | undefined;
  children?: ReactNode;
}>) {
  const { t, rtl } = useI18n();
  const styles = useThemedStyles(makeStyles);
  useEffect(() => (visible ? sheetOpened() : undefined), [visible]);
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <Pressable accessibilityLabel={t("common.close")} onPress={onClose} style={styles.shade} />
        <View style={[styles.sheet, { direction: rtl ? "rtl" : "ltr" }]}>
          <AppText variant="title" accessibilityRole="header">
            {title}
          </AppText>
          <ScrollView contentContainerStyle={styles.list}>{children}</ScrollView>
          <Button kind="quiet" label={closeLabel ?? t("common.close")} onPress={onClose} />
        </View>
      </View>
    </Modal>
  );
}

const makeStyles = (theme: Theme) => ({
  backdrop: { flex: 1, justifyContent: "flex-end" as const },
  shade: {
    position: "absolute" as const,
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: theme.colors.text,
    opacity: 0.4,
  },
  sheet: {
    maxHeight: "70%" as const,
    gap: theme.spacing.md,
    padding: theme.spacing.xl,
    borderTopLeftRadius: theme.radius.lg,
    borderTopRightRadius: theme.radius.lg,
    backgroundColor: theme.colors.background,
  },
  list: { gap: theme.spacing.sm },
});
