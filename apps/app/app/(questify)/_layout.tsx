import { Ionicons } from "@expo/vector-icons";
import type { MessageKey } from "@questify/shared";
import { Tabs, router } from "expo-router";
import { ScanButton } from "#src/components/ScanButton.tsx";
import { useI18n } from "#src/i18n/provider.tsx";
import { useTheme } from "#src/theme/theme.tsx";

type Icon = keyof typeof Ionicons.glyphMap;

// Placeholder icons until the 3D icon set from the brand deck is ready (ADR-013).
const TABS: ReadonlyArray<{ name: string; title: MessageKey; icon: Icon }> = [
  { name: "home", title: "nav.home", icon: "home" },
  { name: "explore", title: "nav.explore", icon: "compass" },
  { name: "scan", title: "nav.scan", icon: "scan" },
  { name: "gem-shop", title: "nav.shop", icon: "diamond" },
  { name: "profile", title: "nav.profile", icon: "person" },
];

/**
 * The bar outside events (FR-830, T-408b): Home, Explore, Scan in the middle, Shop (the gem shop, never an event's
 * shop) and Profile. It looks and orders like the event's bar, in one left-to-right order in both languages (user,
 * ADR-110 note; Q-100). The center button opens the join scanner.
 */
export default function QuestifyTabsLayout() {
  const { t } = useI18n();
  const { theme, text } = useTheme();
  return (
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
            tabBarIcon: ({ color, size }) => <Ionicons name={tab.icon} size={size} color={color} />,
            ...(tab.name === "scan"
              ? {
                  tabBarButton: () => (
                    <ScanButton label={t(tab.title)} onPress={() => router.push("/join-scan")} />
                  ),
                }
              : {}),
          }}
        />
      ))}
    </Tabs>
  );
}
