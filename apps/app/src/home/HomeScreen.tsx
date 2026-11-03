import { router, useLocalSearchParams } from "expo-router";
import { ScrollView } from "react-native";
import { usePlayer } from "#src/auth/player.tsx";
import { AppText } from "#src/components/AppText.tsx";
import { Button } from "#src/components/Controls.tsx";
import { Screen } from "#src/components/Screen.tsx";
import { useHomeDaily } from "#src/daily/DailyCards.tsx";
import { HomeBlock } from "#src/home/HomeBlock.tsx";
import { homeLayoutOf, showsDaily } from "#src/home/home-layout.ts";
import { useHomeConfig } from "#src/home/use-home-config.ts";
import { useI18n } from "#src/i18n/provider.tsx";
import { BellRow } from "#src/push/NotificationBell.tsx";

/**
 * Questify Home (FR-623, FR-832, FR-1838): the blocks the platform chose, in its order, then the sign-in prompt for a
 * visitor who has not signed in. By default they are the player's events live, upcoming and past, the two daily games, the
 * streak line and a door to the Questify quests, with a typed code for anyone who cannot scan one. Public events, "For you"
 * and the Questify ranking are on Explore. Inside an event its own Home takes over (T-113). The layout comes from the
 * configuration the phone holds; without one Home draws the order it always had.
 */
export function HomeScreen() {
  const { t } = useI18n();
  const { state } = usePlayer();
  const config = useHomeConfig();
  const layout = homeLayoutOf(config);
  const daily = useHomeDaily(state.status === "signed_in" && showsDaily(layout.blocks));
  // Operator mode sends people here when the owner removed them (FR-905); an event Home when rehearsal ended (T-211).
  const { notice } = useLocalSearchParams<{ notice?: string }>();
  return (
    <Screen title={t("home.title")} header={<BellRow />}>
      <ScrollView contentContainerStyle={{ gap: 16 }} keyboardShouldPersistTaps="handled">
        {notice === "operatorRemoved" ? (
          <AppText accessibilityRole="alert">{t("operator.removed")}</AppText>
        ) : null}
        {notice === "rehearsalEnded" ? (
          <AppText accessibilityRole="alert">{t("rehearsal.ended")}</AppText>
        ) : null}
        {notice === "eventUnavailable" ? (
          <AppText accessibilityRole="alert">{t("event.unavailable")}</AppText>
        ) : null}
        {layout.blocks.map((block) => (
          <HomeBlock
            key={block}
            block={block}
            config={config}
            banner={layout.banner}
            daily={daily}
          />
        ))}
        {state.status === "signed_out" ? (
          <>
            {state.ended ? (
              <AppText accessibilityRole="alert">{t("signIn.sessionEnded")}</AppText>
            ) : null}
            <AppText muted>{t("home.signedOut")}</AppText>
            <Button label={t("signIn.start")} onPress={() => router.push("/sign-in")} />
          </>
        ) : null}
      </ScrollView>
    </Screen>
  );
}
