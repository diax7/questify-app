import { Ionicons } from "@expo/vector-icons";
import { Tabs, router } from "expo-router";
import type { MessageKey } from "@questify/shared";
import { usePlayer } from "#src/auth/player.tsx";
import { useEvent } from "#src/event/EventContext.tsx";
import { LiveProvider } from "#src/event/LiveContext.tsx";
import { LivePolls } from "#src/event/LivePolls.tsx";
import { useI18n } from "#src/i18n/provider.tsx";
import { ScanButton } from "#src/components/ScanButton.tsx";
import { useTheme } from "#src/theme/theme.tsx";

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
 * The event's bar (FR-620, T-113): Home, Quests, Scan in the middle, Rewards, Profile. The tabs keep one order in both
 * languages, even when the app runs right to left (user, ADR-110 note; FR-620's mirroring is Q-100). The live poll card
 * (T-306) sits over the tabs; one live read serves it and Home's community bar (T-306b).
 */
export default function EventTabsLayout() {
  const { t } = useI18n();
  const { theme, text } = useTheme();
  const { eventId } = useEvent();
  const { state } = usePlayer();
  // An answer unseen in any queue (T-312): a dot on Profile, where Your requests opens.
  const unread = state.status === "signed_in" && (state.me?.help?.unread ?? 0) > 0;
  return (
    <LiveProvider>
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
              ...(tab.name === "profile" && unread
                ? {
                    tabBarBadge: "",
                    tabBarBadgeStyle: {
                      backgroundColor: theme.colors.primaryAction,
                      minWidth: 10,
                      maxHeight: 10,
                      borderRadius: 5,
                    },
                  }
                : {}),
              ...(tab.name === "scan"
                ? {
                    tabBarButton: () => (
                      <ScanButton
                        label={t(tab.title)}
                        onPress={() => router.push(`/event/${eventId}/scan-quest`)}
                      />
                    ),
                  }
                : {}),
            }}
          />
        ))}
      </Tabs>
      <LivePolls />
    </LiveProvider>
  );
}
