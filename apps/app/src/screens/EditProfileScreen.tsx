import { MESSAGES } from "@questify/shared";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { ScrollView } from "react-native";
import { api } from "#src/api/app-session.ts";
import { usePlayer } from "#src/auth/player.tsx";
import { AppText } from "#src/components/AppText.tsx";
import { BackButton } from "#src/components/BackButton.tsx";
import { Button, Field, Problem } from "#src/components/Controls.tsx";
import { Screen } from "#src/components/Screen.tsx";
import { useI18n } from "#src/i18n/provider.tsx";
import { saveProfile } from "#src/questify/profile-api.ts";

export function EditProfileScreen() {
  const { state, reload } = usePlayer();
  const { t } = useI18n();
  const me = state.status === "signed_in" ? state.me : undefined;
  const [username, setUsername] = useState(me?.username ?? "");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ ar: string; en: string } | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    setUsername(me?.username ?? "");
    setProblem(null);
  }, [me?.id]);
  const save = async () => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    setSaved(false);
    const answer = await saveProfile(api.session, { username });
    if (answer.kind === "ok") {
      await reload();
      setSaved(true);
    } else
      setProblem(
        answer.kind === "error" && answer.message !== null
          ? answer.message
          : MESSAGES["profile.saveFailed"],
      );
    setBusy(false);
  };
  return (
    <Screen title={t("profile.edit")} header={<BackButton />}>
      <ScrollView contentContainerStyle={{ gap: 12 }}>
        {me === undefined ? (
          <Button label={t("signIn.start")} onPress={() => router.push("/sign-in")} />
        ) : (
          <>
            <Field
              label={t("signIn.username")}
              value={username}
              autoCapitalize="none"
              maxLength={20}
              editable={me.usernameChange?.allowed === true && !busy}
              onChangeText={(value) => {
                setUsername(value);
                setSaved(false);
              }}
            />
            {me.usernameChange?.allowed === true ? null : (
              <AppText muted>{t("profile.nameLocked")}</AppText>
            )}
            <Problem problem={problem} />
            {saved ? <AppText accessibilityLiveRegion="polite">{t("locker.saved")}</AppText> : null}
            <Button
              label={t("profile.save")}
              disabled={
                busy ||
                me.usernameChange?.allowed !== true ||
                username === me.username ||
                username.trim() === ""
              }
              onPress={() => void save()}
            />
            <Button label={t("locker.title")} kind="quiet" onPress={() => router.push("/locker")} />
          </>
        )}
      </ScrollView>
    </Screen>
  );
}
