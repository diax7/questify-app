import { JOIN_LINK_HOSTS, MESSAGES, type LocalizedText } from "@questify/shared";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { Linking } from "react-native";
import type { SignupAcceptance } from "@questify/shared";
import { api, keyValueStore } from "#src/api/app-session.ts";
import { AppText } from "#src/components/AppText.tsx";
import { Button, Problem } from "#src/components/Controls.tsx";
import { Screen } from "#src/components/Screen.tsx";
import { consentVersions, versionsFrom } from "#src/config/remote.ts";
import { usePlayer } from "#src/auth/player.tsx";
import { useI18n } from "#src/i18n/provider.tsx";

/**
 * A new version of the terms or the privacy policy (FR-1705): shown on launch before anything else, until the player
 * accepts the versions in force (`POST /v1/me/acceptances`). Signing out is the other way out.
 */
export default function ReacceptScreen() {
  const { t, language } = useI18n();
  const { reload, signOut } = usePlayer();
  const [versions, setVersions] = useState<SignupAcceptance | undefined>(undefined);
  const [problem, setProblem] = useState<LocalizedText | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void consentVersions({ client: api.client, store: keyValueStore }).then(setVersions);
  }, []);

  const open = (id: string) =>
    void Linking.openURL(`https://${JOIN_LINK_HOSTS[0]}/${language}/legal/${id}`);

  const accept = async () => {
    if (versions === undefined) {
      return;
    }
    setBusy(true);
    const answer = await api.session.request({
      method: "POST",
      path: "/v1/me/acceptances",
      body: versions,
    });
    setBusy(false);
    if (answer.kind === "ok") {
      await reload();
      router.replace("/");
      return;
    }
    // The versions changed again since this screen loaded them: show the new ones (T-110).
    if (answer.kind === "error" && answer.code === "acceptance_required") {
      setVersions(versionsFrom(answer.details["documents"]));
      setProblem(MESSAGES["signIn.versionsChanged"]);
      return;
    }
    setProblem(answer.kind === "error" ? answer.message : MESSAGES["join.network"]);
  };

  return (
    <Screen title={t("signIn.consentTitle")}>
      <AppText>{t("signIn.consentBody")}</AppText>
      <Button kind="quiet" label={t("signIn.terms")} onPress={() => open("terms_of_use")} />
      <Button kind="quiet" label={t("signIn.privacy")} onPress={() => open("privacy_policy")} />
      {versions === undefined ? <AppText muted>{t("signIn.versionsMissing")}</AppText> : null}
      <Problem problem={problem} />
      <Button
        label={t("signIn.accept")}
        disabled={busy || versions === undefined}
        onPress={() => void accept()}
      />
      <Button
        kind="quiet"
        label={t("signOut.confirm")}
        onPress={() => void signOut().then(() => router.replace("/"))}
      />
    </Screen>
  );
}
