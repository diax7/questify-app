import Ionicons from "@expo/vector-icons/Ionicons";
import { Tabs, router } from "expo-router";
import { ScanButton } from "#src/components/ScanButton.tsx";
import { useI18n } from "#src/i18n/provider.tsx";
import { QUESTIFY_TABS } from "#src/questify/tabs.ts";
import { platform } from "#src/platform/current.ts";
import { tabBarLabelStyle, tabBarStyle } from "#src/platform/tab-bar-style.ts";
import { useTheme } from "#src/theme/theme.tsx";

/**
 * The bar outside events (FR-830, T-408b, T-404d): the tabs are listed in `QUESTIFY_TABS`. It looks and orders like the
 * event's bar, in one left-to-right order in both languages (user, ADR-110 note; Q-100). The center button opens the join
 * scanner.
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
        tabBarStyle: tabBarStyle(theme.colors.navigationBar, platform),
        tabBarLabelStyle: tabBarLabelStyle(text.label, platform),
      }}
    >
      {QUESTIFY_TABS.map((tab) => (
        <Tabs.Screen
          key={tab.name}
          name={tab.name}
          options={{
            title: t(tab.title),
            tabBarIcon: ({ color, size }) => (
              <Ionicons
                name={tab.icon}
                size={size}
                color={color}
                accessible={false}
                importantForAccessibility="no"
              />
            ),
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
