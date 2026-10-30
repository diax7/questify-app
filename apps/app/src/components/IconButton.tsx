import { Ionicons } from "@expo/vector-icons";
import { Pressable } from "react-native";
import { useI18n } from "#src/i18n/provider.tsx";
import { useTheme } from "#src/theme/theme.tsx";

type IconName = keyof typeof Ionicons.glyphMap;

/**
 * A button that shows only an icon (ADR-370): sign out, an info button. `label` is its accessible name, in the
 * screen's language. `mirror` turns an icon with a direction around in a right-to-left screen.
 */
export function IconButton({
  icon,
  label,
  onPress,
  mirror = false,
}: Readonly<{ icon: IconName; label: string; onPress: () => void; mirror?: boolean }>) {
  const { theme } = useTheme();
  const { rtl } = useI18n();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={4}
      onPress={onPress}
      style={{
        width: 44,
        height: 44,
        alignItems: "center",
        justifyContent: "center",
        transform: [{ scaleX: mirror && rtl ? -1 : 1 }],
      }}
    >
      <Ionicons name={icon} size={24} color={theme.colors.text} />
    </Pressable>
  );
}
