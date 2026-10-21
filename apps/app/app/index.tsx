import { router } from "expo-router";
import { useEffect, useRef } from "react";
import { api, keyValueStore } from "#src/api/app-session.ts";
import { usePlayer } from "#src/auth/player.tsx";
import { AppText } from "#src/components/AppText.tsx";
import { Screen } from "#src/components/Screen.tsx";
import { chooseLaunchEvent, readMyEvents, readRecent } from "#src/event/launch.ts";
import { useI18n } from "#src/i18n/provider.tsx";

/**
 * Where the app opens (FR-624, FR-1610): inside the player's live event opened most recently on this phone, else on
 * Questify home. Signed out, or when the events cannot be read, Questify home (which says so, with a retry).
 */
export default function LaunchScreen() {
  const { t } = useI18n();
  const { state } = usePlayer();
  const decided = useRef(false);
  useEffect(() => {
    if (state.status === "loading" || decided.current) {
      return;
    }
    decided.current = true;
    if (state.status === "signed_out") {
      router.replace("/home");
      return;
    }
    void (async () => {
      const answer = await api.session.request({ method: "GET", path: "/v1/me/events" });
      const events = answer.kind === "ok" ? readMyEvents(answer.body) : undefined;
      const chosen =
        events === undefined ? null : chooseLaunchEvent(events, await readRecent(keyValueStore));
      router.replace(chosen === null ? "/home" : `/event/${chosen}`);
    })();
  }, [state.status]);
  return (
    <Screen title={t("home.title")}>
      <AppText muted>{t("common.loading")}</AppText>
    </Screen>
  );
}
