import Ionicons from "@expo/vector-icons/Ionicons";
import { StyleSheet, View } from "react-native";
import { AppText } from "#src/components/AppText.tsx";
import { useTheme } from "#src/theme/theme.tsx";

/**
 * A small wooden shield with the player's Questify level in gold, beside a name on event rankings, the podium and
 * profiles (T-404d, ADR-766). Purely cosmetic: it gives no advantage inside an event. Decorative to a screen reader,
 * because the row or the profile text around it already says "Level n"; the digits are Western in both languages.
 */
export function LevelBadge({ level, size = 28 }: Readonly<{ level: number; size?: number }>) {
  const { theme } = useTheme();
  const digits = size * 0.42;
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      testID="level-badge"
      style={{ width: size, height: size }}
    >
      <View style={styles.layer}>
        <Ionicons name="shield" size={size} color={theme.colors.navigationBar} />
      </View>
      <View style={styles.layer}>
        <Ionicons name="shield" size={size - 5} color={theme.colors.navigationActive} />
      </View>
      <View style={styles.layer}>
        <AppText
          variant="label"
          numberOfLines={1}
          adjustsFontSizeToFit
          style={{ fontSize: digits, lineHeight: digits * 1.3, maxWidth: size * 0.72 }}
        >
          {String(level)}
        </AppText>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  layer: {
    position: "absolute",
    top: 0,
    bottom: 0,
    start: 0,
    end: 0,
    alignItems: "center",
    justifyContent: "center",
  },
});
