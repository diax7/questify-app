import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { AppText } from "#src/components/AppText.tsx";
import { useI18n } from "#src/i18n/provider.tsx";
import { colors, spacing } from "#src/theme/tokens.ts";

/**
 * The frame every tab screen shares: parchment background, safe areas, a title. Layout uses start and end, and the
 * content takes the language's direction itself, so a screen mirrors in Arabic even when the app as a whole could
 * not (Expo Go). The tab bar sits outside this frame.
 */
export function Screen({ title, children }: { title: string; children?: ReactNode }) {
  const { rtl } = useI18n();
  return (
    <SafeAreaView edges={["top"]} style={styles.page}>
      <View style={[styles.content, { direction: rtl ? "rtl" : "ltr" }]}>
        <AppText variant="display">{title}</AppText>
        {children}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.background },
  content: { flex: 1, paddingHorizontal: spacing.xl, paddingTop: spacing.lg, gap: spacing.lg },
});
