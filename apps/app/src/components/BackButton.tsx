import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { Pressable } from "react-native";
import { AppText } from "#src/components/AppText.tsx";
import { useI18n } from "#src/i18n/provider.tsx";
import { useTheme } from "#src/theme/theme.tsx";

/** A visible way back for a screen over the tabs; its arrow points to the start of the line in either language. */
export function BackButton() {
  const { t, rtl } = useI18n();
  const { theme } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      // The row is about 22 high; the slop brings the touch area to 46 (44 pt / 48 dp minimum).
      hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }}
      onPress={() => (router.canGoBack() ? router.back() : router.replace("/"))}
      style={{
        flexDirection: "row",
        alignItems: "center",
        alignSelf: "flex-start",
        gap: theme.spacing.xs,
      }}
    >
      <Ionicons
        name={rtl ? "chevron-forward" : "chevron-back"}
        size={22}
        color={theme.colors.text}
      />
      <AppText variant="label">{t("common.back")}</AppText>
    </Pressable>
  );
}
