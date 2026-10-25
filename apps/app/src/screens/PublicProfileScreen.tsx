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
import { publicProfileSchema, type PublicProfile } from "#src/questify/profile-api.ts";

export function PublicProfileScreen() {
  const { username } = useLocalSearchParams<{ username: string }>();
  const { state } = usePlayer();
  const { t, language } = useI18n();
  const [result, setResult] = useState<PublicProfile | "loading" | "unavailable" | "failed">(
    "loading",
  );
  const [attempt, setAttempt] = useState(0);
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
  }, [username, attempt, state.status]);
  return (
    <Screen title={t("profile.public")} header={<BackButton />}>
      <ScrollView contentContainerStyle={{ gap: 12 }}>
        {state.status !== "signed_in" ? (
          <Button label={t("signIn.start")} onPress={() => router.push("/sign-in")} />
        ) : typeof result === "string" ? (
          <>
            <AppText accessibilityLiveRegion="polite">
              {t(
                result === "loading"
                  ? "common.loading"
                  : result === "unavailable"
                    ? "profile.unavailable"
                    : "profile.failed",
              )}
            </AppText>
            {result === "failed" ? (
              <Button label={t("common.retry")} onPress={() => setAttempt((n) => n + 1)} />
            ) : null}
          </>
        ) : (
          <>
            <Avatar
              name={"starter" in result.character ? result.character.starter : ""}
              username={result.username}
              size={120}
              equipment={{
                character: "starter" in result.character ? null : result.character,
                frame: result.frame,
                title: result.title,
              }}
            />
            <AppText variant="title">@{result.username}</AppText>
            {result.title === null ? null : (
              <>
                <AppText variant="label">{t("profile.equippedTitle")}</AppText>
                <AppText>{result.title.name[language]}</AppText>
              </>
            )}
            <AppText>{t("level.number", { level: result.level.number })}</AppText>
            <AppText variant="label">{t("locker.levelTitle")}</AppText>
            <AppText>{result.level.title[language]}</AppText>
          </>
        )}
      </ScrollView>
    </Screen>
  );
}
