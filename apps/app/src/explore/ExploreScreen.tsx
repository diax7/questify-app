import { router } from "expo-router";
import { ScrollView } from "react-native";
import { usePlayer } from "#src/auth/player.tsx";
import { AppText } from "#src/components/AppText.tsx";
import { Button } from "#src/components/Controls.tsx";
import { Screen } from "#src/components/Screen.tsx";
import { ForYouSection } from "#src/explore/ForYouSection.tsx";
import { PublicEvents } from "#src/explore/PublicEvents.tsx";
import { QuestifyRanking } from "#src/explore/QuestifyRanking.tsx";
import { useI18n } from "#src/i18n/provider.tsx";

/**
 * Explore (FR-833): events suggested for the player, the Questify-wide ranking and the public events anyone can open.
 * Signed out, the public events stay and the other two ask for a sign-in. This is the only place the Questify-wide
 * ranking is shown; no event screen has it (FR-612).
 */
export function ExploreScreen() {
  const { t } = useI18n();
  const { state } = usePlayer();
  const signedIn = state.status === "signed_in";
  return (
    <Screen title={t("nav.explore")}>
      <ScrollView contentContainerStyle={{ gap: 16 }}>
        {signedIn ? (
          <>
            <ForYouSection />
            <QuestifyRanking />
          </>
        ) : null}
        {state.status === "signed_out" ? (
          <>
            <AppText muted>{t("explore.signInPrompt")}</AppText>
            <Button label={t("signIn.start")} onPress={() => router.push("/sign-in")} />
          </>
        ) : null}
        <PublicEvents />
      </ScrollView>
    </Screen>
  );
}
