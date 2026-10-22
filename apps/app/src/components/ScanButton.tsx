import { Ionicons } from "@expo/vector-icons";
import type { Theme } from "@questify/shared";
import { Pressable, View } from "react-native";
import { useTheme, useThemedStyles } from "#src/theme/theme.tsx";

/**
 * The large round button in the middle of the bar (FR-620, FR-621). It replaces the tab's own button, so it never
 * opens the tab's screen: it opens a scanner over the tabs (the player's, or the operator's station).
 */
export function ScanButton({ label, onPress }: Readonly<{ label: string; onPress: () => void }>) {
  const { theme } = useTheme();
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.scanSlot}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        onPress={onPress}
        style={styles.scan}
      >
        <Ionicons name="scan" size={30} color={theme.colors.onPrimaryAction} />
      </Pressable>
    </View>
  );
}

const makeStyles = (theme: Theme) => ({
  scanSlot: { flex: 1, alignItems: "center" as const },
  scan: {
    width: 64,
    height: 64,
    marginTop: -20,
    borderRadius: theme.radius.pill,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    borderWidth: 3,
    borderColor: theme.colors.navigationBar,
    backgroundColor: theme.colors.primaryAction,
  },
});
