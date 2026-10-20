import type { Theme } from "@questify/shared";
import type { ReactNode } from "react";
import { View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { AppText } from "#src/components/AppText.tsx";
import { useI18n } from "#src/i18n/provider.tsx";
import { useThemedStyles } from "#src/theme/theme.tsx";

/**
 * The frame every tab screen shares: the theme's page background, safe areas, a title. Layout uses start and end, and
 * the content takes the language's direction itself, so a screen mirrors in Arabic even when the app as a whole could
 * not (Expo Go). The tab bar sits outside this frame.
 */
export function Screen({ title, children }: { title: string; children?: ReactNode }) {
  const { rtl } = useI18n();
  const styles = useThemedStyles(makeStyles);
  return (
    <SafeAreaView edges={["top"]} style={styles.page}>
      <View style={[styles.content, { direction: rtl ? "rtl" : "ltr" }]}>
        <AppText variant="display">{title}</AppText>
        {children}
      </View>
    </SafeAreaView>
  );
}

const makeStyles = (theme: Theme) => ({
  page: { flex: 1, backgroundColor: theme.colors.background },
  content: {
    flex: 1,
    paddingHorizontal: theme.spacing.xl,
    paddingTop: theme.spacing.lg,
    gap: theme.spacing.lg,
  },
});
