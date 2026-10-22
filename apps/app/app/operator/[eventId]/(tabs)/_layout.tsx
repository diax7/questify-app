import { Ionicons } from "@expo/vector-icons";
import { Tabs, router } from "expo-router";
import type { MessageKey } from "@questify/shared";
import { ScanButton } from "#src/components/ScanButton.tsx";
import { useI18n } from "#src/i18n/provider.tsx";
import { useOperator } from "#src/operator/OperatorContext.tsx";
import { useTheme } from "#src/theme/theme.tsx";

type Icon = keyof typeof Ionicons.glyphMap;

// Placeholder icons until the 3D icon set from the brand deck is ready (ADR-013).
const TABS: ReadonlyArray<{ name: string; title: MessageKey; icon: Icon }> = [
  { name: "index", title: "operator.home", icon: "home" },
  { name: "desk", title: "operator.desk", icon: "gift" },
  { name: "scan", title: "operator.scan", icon: "scan" },
  { name: "inbox", title: "operator.inbox", icon: "chatbubbles" },
  { name: "tools", title: "operator.tools", icon: "construct" },
];

/**
 * Operator mode's bar (FR-920, ADR-057): Home, Prize desk, the round Scan button, Inbox, Tools, in one order in both
 * languages like the player's bar. The round button opens the station scanner.
 */
export default function OperatorTabsLayout() {
  const { t } = useI18n();
  const { theme, text } = useTheme();
  const { eventId } = useOperator();
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
                    <ScanButton
                      label={t(tab.title)}
                      onPress={() => router.push(`/operator/${eventId}/station-scan`)}
                    />
                  ),
                }
              : {}),
          }}
        />
      ))}
    </Tabs>
  );
}
