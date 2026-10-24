import { Ionicons } from "@expo/vector-icons";
import { Tabs, router, useFocusEffect } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { AppState } from "react-native";
import { api } from "#src/api/app-session.ts";
import type { MessageKey } from "@questify/shared";
import { ScanButton } from "#src/components/ScanButton.tsx";
import { useI18n } from "#src/i18n/provider.tsx";
import { fetchInboxTotal } from "#src/operator/inbox.ts";
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

/** How often the Inbox badge reads its count while staff mode is in the foreground (T-310). */
const BADGE_REFRESH_MS = 30_000;

/** The Inbox badge: what waits, read on focus and every 30 seconds while the app is in the foreground. */
function useInboxBadge(eventId: string): number | undefined {
  const [total, setTotal] = useState<number | null>(null);
  const [active, setActive] = useState(AppState.currentState === "active");
  const read = useCallback(async () => {
    setTotal(await fetchInboxTotal(api.session, eventId));
  }, [eventId]);
  useFocusEffect(
    useCallback(() => {
      void read();
    }, [read]),
  );
  useEffect(() => {
    const watcher = AppState.addEventListener("change", (state) => setActive(state === "active"));
    return () => watcher.remove();
  }, []);
  useEffect(() => {
    if (!active) {
      return;
    }
    const timer = setInterval(() => void read(), BADGE_REFRESH_MS);
    return () => clearInterval(timer);
  }, [active, read]);
  return total === null || total === 0 ? undefined : total;
}

/**
 * Operator mode's bar (FR-920, ADR-057): Home, Prize desk, the round Scan button, Inbox, Tools, in one order in both
 * languages like the player's bar. The round button opens the station scanner.
 */
export default function OperatorTabsLayout() {
  const { t } = useI18n();
  const { theme, text } = useTheme();
  const { eventId } = useOperator();
  const badge = useInboxBadge(eventId);
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
            ...(tab.name === "inbox" && badge !== undefined ? { tabBarBadge: badge } : {}),
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
