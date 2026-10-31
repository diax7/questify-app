import { Ionicons } from "@expo/vector-icons";
import { Tabs, router } from "expo-router";
import { PLAYER_TABS, playerTabs, type MessageKey, type PlayerTab } from "@questify/shared";
import { usePlayer } from "#src/auth/player.tsx";
import { useEvent } from "#src/event/EventContext.tsx";
import { LiveProvider } from "#src/event/LiveContext.tsx";
import { LivePolls } from "#src/event/LivePolls.tsx";
import { useI18n } from "#src/i18n/provider.tsx";
import { ScanButton } from "#src/components/ScanButton.tsx";
import { useTheme } from "#src/theme/theme.tsx";

type Icon = keyof typeof Ionicons.glyphMap;

// Placeholder icons until the 3D icon set from the brand deck is ready (ADR-013).
const ICONS: Readonly<Record<PlayerTab, Icon>> = {
  index: "home",
  quests: "map",
  scan: "scan",
  rewards: "gift",
  profile: "person",
};

const TABS: ReadonlyArray<{ name: PlayerTab; title: MessageKey; icon: Icon }> = PLAYER_TABS.map(
  ({ tab, title }) => ({ name: tab, title, icon: ICONS[tab] }),
);

/**
 * The event's bar (FR-620, T-113): Home, Quests, Scan in the middle, Rewards (gone while the shop is switched off, T-602),
 * Profile. The tabs keep one order in both
 * languages, even when the app runs right to left (user, ADR-110 note; FR-620's mirroring is Q-100). The live poll card
 * (T-306) sits over the tabs; one live read serves it and Home's community bar (T-306b).
 */
export default function EventTabsLayout() {
  const { t } = useI18n();
  const { theme, text } = useTheme();
  const { eventId, featureOn } = useEvent();
  const shown = new Set(playerTabs(featureOn).map((entry) => entry.tab));
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
              // A switched-off feature takes its tab off the bar; the shared rule (`playerTabs`) is the preview's too.
              ...(shown.has(tab.name) ? {} : { href: null }),
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
