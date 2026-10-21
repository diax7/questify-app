import { Ionicons } from "@expo/vector-icons";
import { Tabs } from "expo-router";
import { useState } from "react";
import { Pressable, View } from "react-native";
import type { MessageKey, Theme } from "@questify/shared";
import { AppText } from "#src/components/AppText.tsx";
import { Sheet } from "#src/components/Sheet.tsx";
import { useI18n } from "#src/i18n/provider.tsx";
import { useTheme, useThemedStyles } from "#src/theme/theme.tsx";

type Icon = keyof typeof Ionicons.glyphMap;

// Placeholder icons until the 3D icon set from the brand deck is ready (ADR-013).
const TABS: ReadonlyArray<{ name: string; title: MessageKey; icon: Icon }> = [
  { name: "index", title: "nav.home", icon: "home" },
  { name: "quests", title: "nav.quests", icon: "map" },
  { name: "scan", title: "nav.scan", icon: "scan" },
  { name: "rewards", title: "nav.rewards", icon: "gift" },
  { name: "profile", title: "nav.profile", icon: "person" },
];

/**
 * The large round button in the middle of the bar (FR-620). It replaces the tab's own button, so it never opens the
 * tab's screen: until T-115 (the scanner and My QR) it opens a "coming soon" sheet.
 */
function ScanButton({ label, onPress }: Readonly<{ label: string; onPress: () => void }>) {
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

/**
 * The event's bar (FR-620, T-113): Home, Quests, Scan in the middle, Rewards, Profile. The tabs keep one order in both
 * languages, even when the app runs right to left (user, ADR-110 note; FR-620's mirroring is Q-100).
 */
export default function EventTabsLayout() {
  const { t } = useI18n();
  const { theme, text } = useTheme();
  const [soon, setSoon] = useState(false);
  return (
    <>
      <Tabs
        screenOptions={{
          headerShown: false,
          tabBarActiveTintColor: theme.colors.navigationActive,
          tabBarInactiveTintColor: theme.colors.navigationInactive,
          tabBarStyle: { backgroundColor: theme.colors.navigationBar, direction: "ltr" },
          tabBarLabelStyle: { fontFamily: text.label.fontFamily, fontSize: text.label.fontSize },
        }}
      >
        {TABS.map((tab) => (
          <Tabs.Screen
            key={tab.name}
            name={tab.name}
            options={{
              title: t(tab.title),
              tabBarIcon: ({ color, size }) => (
                <Ionicons name={tab.icon} size={size} color={color} />
              ),
              ...(tab.name === "scan"
                ? {
                    tabBarButton: () => (
                      <ScanButton label={t(tab.title)} onPress={() => setSoon(true)} />
                    ),
                  }
                : {}),
            }}
          />
        ))}
      </Tabs>
      <Sheet visible={soon} title={t("scan.soonTitle")} onClose={() => setSoon(false)}>
        <AppText>{t("scan.soonBody")}</AppText>
      </Sheet>
    </>
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
