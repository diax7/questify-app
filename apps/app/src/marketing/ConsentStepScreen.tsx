import { MARKETING_CHANNELS, type MessageKey } from "@questify/shared";
import { router } from "expo-router";
import { useState } from "react";
import { ScrollView } from "react-native";
import { api } from "#src/api/app-session.ts";
import { usePlayer } from "#src/auth/player.tsx";
import { AppText } from "#src/components/AppText.tsx";
import { Button } from "#src/components/Controls.tsx";
import { Screen } from "#src/components/Screen.tsx";
import { useI18n } from "#src/i18n/provider.tsx";
import { ChannelRow } from "#src/marketing/ChannelRow.tsx";
import { saveMarketing } from "#src/marketing/marketing-api.ts";
import {
  NO_TICKS,
  consentNotice,
  rememberAnswer,
  signupBody,
  type Ticks,
} from "#src/marketing/marketing-flow.ts";

/**
 * The one-time marketing step after sign-up (FR-735, ADR-316): three separate switches, all off, with Save and "No
 * offers, thanks". Either answer is recorded for all three channels, so the step is never asked again; the settings
 * screen changes any of them later. The wording is not part of the privacy policy and nothing here is required.
 */
export function ConsentStepScreen() {
  const { t } = useI18n();
  const { state, reload } = usePlayer();
  const playerId = state.status === "signed_in" ? state.me?.id : undefined;
  const [ticks, setTicks] = useState<Ticks>(NO_TICKS);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<MessageKey | null>(null);

  const answer = async (chosen: Ticks) => {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    const outcome = await saveMarketing(api.session, signupBody(chosen));
    if (outcome.kind === "saved" || outcome.kind === "signed_out") {
      if (outcome.kind === "saved" && playerId !== undefined) rememberAnswer(playerId);
      await reload();
      router.replace(outcome.kind === "saved" ? "/" : "/home");
      return;
    }
    // An account that may not opt in is told so; reading the profile again ends the step for it.
    if (outcome.kind === "age") await reload();
    setNotice(consentNotice(outcome));
    setBusy(false);
  };

  return (
    <Screen title={t("marketing.title")}>
      <ScrollView contentContainerStyle={{ gap: 16 }}>
        <AppText>{t("marketing.intro")}</AppText>
        {MARKETING_CHANNELS.map((channel) => (
          <ChannelRow
            key={channel}
            channel={channel}
            on={ticks[channel]}
            disabled={busy}
            onChange={(on) => setTicks((current) => ({ ...current, [channel]: on }))}
          />
        ))}
        <AppText muted>{t("marketing.stop")}</AppText>
        {notice === null ? null : (
          <AppText accessibilityRole="alert" accessibilityLiveRegion="polite">
            {t(notice)}
          </AppText>
        )}
        <Button label={t("marketing.save")} disabled={busy} onPress={() => void answer(ticks)} />
        <Button
          kind="quiet"
          label={t("marketing.skip")}
          disabled={busy}
          onPress={() => void answer(NO_TICKS)}
        />
      </ScrollView>
    </Screen>
  );
}
