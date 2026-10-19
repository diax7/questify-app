import { Ionicons } from "@expo/vector-icons";
import { Tabs } from "expo-router";
import type { MessageKey } from "@questify/shared";
import { useI18n } from "#src/i18n/provider.tsx";
import { colors, fontFamily, typography } from "#src/theme/tokens.ts";

type Icon = keyof typeof Ionicons.glyphMap;

// Placeholder icons until the 3D icon set from the brand deck is ready (ADR-013).
const TABS: ReadonlyArray<{ name: string; title: MessageKey; icon: Icon }> = [
  { name: "index", title: "nav.home", icon: "home" },
  { name: "quests", title: "nav.quests", icon: "map" },
  { name: "ranking", title: "nav.ranking", icon: "trophy" },
  { name: "shop", title: "nav.shop", icon: "gift" },
  { name: "profile", title: "nav.profile", icon: "person" },
];

export default function TabsLayout() {
  const { t } = useI18n();
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.navigationActive,
        tabBarInactiveTintColor: colors.navigationInactive,
        // The tabs keep one order in both languages, even when the app runs right to left (user, ADR-110 note).
        tabBarStyle: { backgroundColor: colors.navigationBar, direction: "ltr" },
        tabBarLabelStyle: {
          fontFamily: fontFamily.bodySemiBold,
          fontSize: typography.label.fontSize,
        },
      }}
    >
      {TABS.map((tab) => (
        <Tabs.Screen
          key={tab.name}
          name={tab.name}
          options={{
            title: t(tab.title),
            tabBarIcon: ({ color, size }) => <Ionicons name={tab.icon} size={size} color={color} />,
          }}
        />
      ))}
    </Tabs>
  );
}
