import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { ScrollView } from "react-native";
import { api } from "#src/api/app-session.ts";
import { usePlayer } from "#src/auth/player.tsx";
import { Avatar } from "#src/components/Avatar.tsx";
import { AppText } from "#src/components/AppText.tsx";
import { BackButton } from "#src/components/BackButton.tsx";
import { Button } from "#src/components/Controls.tsx";
import { Screen } from "#src/components/Screen.tsx";
import { useI18n } from "#src/i18n/provider.tsx";
import { PublicAchievements } from "#src/questify/AchievementsSection.tsx";
import { PublicPassport } from "#src/questify/PassportSection.tsx";
import { publicProfileSchema, type PublicProfile } from "#src/questify/profile-api.ts";

export function PublicProfileScreen() {
  const { username } = useLocalSearchParams<{ username: string }>();
  const { state } = usePlayer();
  const { t, language } = useI18n();
  const [result, setResult] = useState<PublicProfile | "loading" | "unavailable" | "failed">(
    "loading",
  );
  const [attempt, setAttempt] = useState(0);
  const owner = state.status === "signed_in" ? state.me?.id : undefined;
  const requestKey = `${owner ?? ""}:${username}`;
  const [loadedKey, setLoadedKey] = useState("");
  useEffect(() => {
    let current = true;
    setResult("loading");
    if (state.status !== "signed_in")
      return () => {
        current = false;
      };
    void api.session
      .request({ method: "GET", path: `/v1/players/${encodeURIComponent(username)}` })
      .then((answer) => {
        if (!current) return;
        setLoadedKey(requestKey);
        if (answer.kind === "error" && answer.status === 404) {
          setResult("unavailable");
          return;
        }
        const parsed = answer.kind === "ok" ? publicProfileSchema.safeParse(answer.body) : null;
        setResult(parsed?.success === true ? parsed.data : "failed");
      });
    return () => {
      current = false;
    };
  }, [username, attempt, state.status, requestKey]);
  const shown = loadedKey === requestKey ? result : "loading";
  return (
    <Screen title={t("profile.public")} header={<BackButton />}>
      <ScrollView contentContainerStyle={{ gap: 12 }}>
        {state.status !== "signed_in" ? (
          <Button label={t("signIn.start")} onPress={() => router.push("/sign-in")} />
        ) : typeof shown === "string" ? (
          <>
            <AppText accessibilityLiveRegion="polite">
              {t(
                shown === "loading"
                  ? "common.loading"
                  : shown === "unavailable"
                    ? "profile.unavailable"
                    : "profile.failed",
              )}
            </AppText>
            {shown === "failed" ? (
              <Button label={t("common.retry")} onPress={() => setAttempt((n) => n + 1)} />
            ) : null}
          </>
        ) : (
          <>
            <Avatar
              name={"starter" in shown.character ? shown.character.starter : ""}
              username={shown.username}
              size={120}
              equipment={{
                character: "starter" in shown.character ? null : shown.character,
                frame: shown.frame,
                title: shown.title,
              }}
            />
            <AppText variant="title">@{shown.username}</AppText>
            {shown.title === null ? null : (
              <>
                <AppText variant="label">{t("profile.equippedTitle")}</AppText>
                <AppText>{shown.title.name[language]}</AppText>
              </>
            )}
            <AppText>{t("level.number", { level: shown.level.number })}</AppText>
            <AppText variant="label">{t("locker.levelTitle")}</AppText>
            <AppText>{shown.level.title[language]}</AppText>
            <PublicAchievements tiers={shown.achievements} />
            <PublicPassport stamps={shown.passport} />
          </>
        )}
      </ScrollView>
    </Screen>
  );
}
