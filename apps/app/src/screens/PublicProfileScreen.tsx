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
import { BlockButton, BlockedLine } from "#src/questify/BlockButton.tsx";
import { PublicPassport } from "#src/questify/PassportSection.tsx";
import { publicProfileSchema, type PublicProfile } from "#src/questify/profile-api.ts";

/** The public profile itself, and Block for anyone but the reader (FR-1415). */
function ProfileDetails({
  profile,
  own,
  onBlock,
}: Readonly<{ profile: PublicProfile; own: boolean; onBlock: (blocked: boolean) => void }>) {
  const { t, language } = useI18n();
  return (
    <>
      <Avatar
        name={"starter" in profile.character ? profile.character.starter : ""}
        username={profile.username}
        size={120}
        equipment={{
          character: "starter" in profile.character ? null : profile.character,
          frame: profile.frame,
          title: profile.title,
        }}
      />
      <AppText variant="title">@{profile.username}</AppText>
      {profile.title === null ? null : (
        <>
          <AppText variant="label">{t("profile.equippedTitle")}</AppText>
          <AppText>{profile.title.name[language]}</AppText>
        </>
      )}
      <AppText>{t("level.number", { level: profile.level.number })}</AppText>
      <AppText variant="label">{t("locker.levelTitle")}</AppText>
      <AppText>{profile.level.title[language]}</AppText>
      <PublicAchievements tiers={profile.achievements} />
      <PublicPassport stamps={profile.passport} />
      {own ? null : <BlockButton username={profile.username} onChange={onBlock} />}
    </>
  );
}

export function PublicProfileScreen() {
  const { username } = useLocalSearchParams<{ username: string }>();
  const { state } = usePlayer();
  const { t } = useI18n();
  const [result, setResult] = useState<PublicProfile | "loading" | "unavailable" | "failed">(
    "loading",
  );
  const [attempt, setAttempt] = useState(0);
  // Blocked on this screen: the profile gives way to a line and Unblock; unblocking reads the profile again.
  const [blocked, setBlocked] = useState(false);
  const changeBlock = (now: boolean) => {
    setBlocked(now);
    if (!now) {
      setAttempt((n) => n + 1);
    }
  };
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
        ) : blocked ? (
          <BlockedLine username={username} onChange={changeBlock} />
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
          <ProfileDetails
            profile={shown}
            own={shown.username.toLowerCase() === state.me?.username.toLowerCase()}
            onBlock={changeBlock}
          />
        )}
      </ScrollView>
    </Screen>
  );
}
