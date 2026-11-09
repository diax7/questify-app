import { ProfileGate } from "#src/questify/ProfileGate.tsx";
import { USERNAME_MAX } from "@questify/shared";
import { router } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { ScrollView } from "react-native";
import { api } from "#src/api/app-session.ts";
import { usePlayer } from "#src/auth/player.tsx";
import { AppText } from "#src/components/AppText.tsx";
import { BackButton } from "#src/components/BackButton.tsx";
import { Button, Field, Problem } from "#src/components/Controls.tsx";
import { Screen } from "#src/components/Screen.tsx";
import { useI18n } from "#src/i18n/provider.tsx";
import { saveProfile } from "#src/questify/profile-api.ts";
import {
  nameChangeAllowed,
  saveDisabled,
  saveProblem,
  signedInMe,
  usernameOf,
} from "#src/screens/edit-profile.ts";

export function EditProfileScreen() {
  const { state, reload } = usePlayer();
  const { t } = useI18n();
  const me = signedInMe(state);
  const allowed = nameChangeAllowed(me);
  const owner = useRef(me?.id);
  owner.current = me?.id;
  const [username, setUsername] = useState(usernameOf(me));
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ ar: string; en: string } | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    setUsername(usernameOf(me));
    setProblem(null);
    setBusy(false);
    setSaved(false);
  }, [me?.id]);
  const save = async () => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    setSaved(false);
    const current = owner.current;
    const answer = await saveProfile(api.session, { username });
    if (current !== owner.current) return;
    if (answer.kind === "ok") {
      await reload();
      if (current !== owner.current) return;
      setSaved(true);
    } else setProblem(saveProblem(answer));
    setBusy(false);
  };
  return (
    <Screen title={t("profile.edit")} header={<BackButton />}>
      <ScrollView contentContainerStyle={{ gap: 12 }}>
        {me === undefined ? (
          <ProfileGate />
        ) : (
          <>
            <Field
              label={t("signIn.username")}
              value={username}
              autoCapitalize="none"
              maxLength={USERNAME_MAX}
              editable={allowed && !busy}
              onChangeText={(value) => {
                setUsername(value);
                setSaved(false);
              }}
            />
            {allowed ? null : <AppText muted>{t("profile.nameLocked")}</AppText>}
            <Problem problem={problem} />
            {saved ? <AppText accessibilityLiveRegion="polite">{t("locker.saved")}</AppText> : null}
            <Button
              label={t("profile.save")}
              disabled={saveDisabled({ busy, allowed, username, current: me.username })}
              onPress={() => void save()}
            />
            <Button label={t("locker.title")} kind="quiet" onPress={() => router.push("/locker")} />
          </>
        )}
      </ScrollView>
    </Screen>
  );
}
