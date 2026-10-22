import type { LocalizedText } from "@questify/shared";
import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { api } from "#src/api/app-session.ts";
import { randomUuid } from "#src/api/uuid.ts";
import { usePlayer } from "#src/auth/player.tsx";
import { AppText } from "#src/components/AppText.tsx";
import { BackButton } from "#src/components/BackButton.tsx";
import { Button } from "#src/components/Controls.tsx";
import { Screen } from "#src/components/Screen.tsx";
import { useI18n } from "#src/i18n/provider.tsx";
import { textIn } from "#src/i18n/text.ts";
import { claimInvite, previewInvite, type InvitePreview } from "#src/operator/operator-api.ts";

type Step =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "confirm"; preview: InvitePreview }>
  | Readonly<{ kind: "refused"; message: LocalizedText | null; emailMismatch: boolean }>
  | Readonly<{ kind: "network" }>;

/**
 * FR-903: a personal operator code or an invite link opens this screen. It names the event and asks the person to
 * confirm; declining leaves the code unused. A person not signed in signs in first and comes back here.
 */
export default function OperatorInviteScreen() {
  const { token } = useLocalSearchParams<{ token: string }>();
  const { t, language } = useI18n();
  const { state } = usePlayer();
  const [step, setStep] = useState<Step>({ kind: "loading" });
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setStep({ kind: "loading" });
    const answer = await previewInvite(api.session, token);
    if (answer.kind === "preview") {
      setStep({ kind: "confirm", preview: answer.preview });
    } else if (answer.kind === "refused") {
      setStep({
        kind: "refused",
        message: answer.message,
        emailMismatch: answer.code === "invite_email_mismatch",
      });
    } else {
      setStep({ kind: "network" });
    }
  }, [token]);
  useEffect(() => {
    if (state.status === "signed_in") {
      void load();
    }
  }, [load, state.status]);

  const confirm = async () => {
    setBusy(true);
    const answer = await claimInvite(api.session, token, randomUuid());
    setBusy(false);
    if (answer.kind === "claimed") {
      router.replace(`/operator/${answer.eventId}`);
    } else if (answer.kind === "refused") {
      setStep({ kind: "refused", message: answer.message, emailMismatch: false });
    } else {
      setStep({ kind: "network" });
    }
  };

  if (state.status === "signed_out") {
    return (
      <Screen title={t("invitePage.title")} header={<BackButton />}>
        <AppText>{t("invitePage.body")}</AppText>
        <Button
          label={t("signIn.start")}
          onPress={() => router.replace({ pathname: "/sign-in", params: { invite: token } })}
        />
      </Screen>
    );
  }
  return (
    <Screen title={t("invitePage.title")} header={<BackButton />}>
      <View style={{ gap: 12 }}>
        {step.kind === "loading" ? <AppText muted>{t("common.loading")}</AppText> : null}
        {step.kind === "confirm" ? (
          <>
            <AppText variant="title">
              {t("operator.claimTitle", { event: textIn(step.preview.event.name, language) })}
            </AppText>
            <AppText>{t("operator.claimBody")}</AppText>
            <Button label={t("operator.confirm")} disabled={busy} onPress={() => void confirm()} />
            <Button kind="quiet" label={t("operator.notNow")} onPress={() => router.replace("/")} />
          </>
        ) : null}
        {step.kind === "refused" ? (
          <>
            <AppText accessibilityRole="alert">
              {step.message === null ? t("join.network") : step.message[language]}
            </AppText>
            {step.emailMismatch ? <AppText>{t("operator.emailHint")}</AppText> : null}
          </>
        ) : null}
        {step.kind === "network" ? (
          <>
            <AppText accessibilityRole="alert">{t("join.network")}</AppText>
            <Button kind="quiet" label={t("common.retry")} onPress={() => void load()} />
          </>
        ) : null}
      </View>
    </Screen>
  );
}
