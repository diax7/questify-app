import { router, useLocalSearchParams } from "expo-router";
import { ScrollView } from "react-native";
import { AddEmailCard } from "#src/account/AddEmailCard.tsx";
import { usePlayer } from "#src/auth/player.tsx";
import { AppText } from "#src/components/AppText.tsx";
import { Button } from "#src/components/Controls.tsx";
import { Screen } from "#src/components/Screen.tsx";
import { DailyCards } from "#src/daily/DailyCards.tsx";
import { CodeEntry } from "#src/home/CodeEntry.tsx";
import { Invitations } from "#src/home/Invitations.tsx";
import { MyEvents } from "#src/home/MyEvents.tsx";
import { StreakLine } from "#src/home/StreakLine.tsx";
import { useI18n } from "#src/i18n/provider.tsx";
import { OperatorEvents } from "#src/operator/OperatorEvents.tsx";
import { BellRow } from "#src/push/NotificationBell.tsx";

/**
 * Questify Home (FR-623, FR-832): the player's events live, upcoming and past, the two daily games, the streak line and
 * a door to the Questify quests, with a typed code for anyone who cannot scan one. Public events, "For you" and the
 * Questify ranking are on Explore. Inside an event its own Home takes over (T-113).
 */
export function HomeScreen() {
  const { t } = useI18n();
  const { state } = usePlayer();
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
        <CodeEntry />
        {state.status === "signed_in" ? (
          <>
            <AddEmailCard />
            <OperatorEvents />
            <Invitations />
            <StreakLine />
            <DailyCards />
            <MyEvents />
            <Button
              kind="quiet"
              label={t("questifyQuests.title")}
              onPress={() => router.push("/questify-quests")}
            />
          </>
        ) : null}
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
