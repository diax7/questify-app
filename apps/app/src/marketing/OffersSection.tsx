import {
  MARKETING_CHANNELS,
  type Marketing,
  type MarketingChannel,
  type MessageKey,
} from "@questify/shared";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { ScrollView } from "react-native";
import { api } from "#src/api/app-session.ts";
import { AppText } from "#src/components/AppText.tsx";
import { BackButton } from "#src/components/BackButton.tsx";
import { Button } from "#src/components/Controls.tsx";
import { Screen } from "#src/components/Screen.tsx";
import { useI18n } from "#src/i18n/provider.tsx";
import { ChannelRow } from "#src/marketing/ChannelRow.tsx";
import { fetchMarketing, saveMarketing } from "#src/marketing/marketing-api.ts";
import { consentNotice, switchBody, ticksOf } from "#src/marketing/marketing-flow.ts";
import { useRead } from "#src/questify/use-read.ts";

/** The saved state after the player's own switches, the save in flight and its notice (one save at a time). */
function useChannelSave(fresh: Marketing | null) {
  const [saved, setSaved] = useState<Marketing | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<MessageKey | null>(null);
  // A fresher read (the screen gained focus again) replaces what an earlier save here left.
  useEffect(() => setSaved(null), [fresh]);
  const change = async (channel: MarketingChannel, on: boolean) => {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    const outcome = await saveMarketing(api.session, switchBody(channel, on));
    if (outcome.kind === "saved") setSaved(outcome.marketing);
    if (outcome.kind === "signed_out") router.replace("/home");
    setNotice(consentNotice(outcome));
    setBusy(false);
  };
  return { current: saved ?? fresh, busy, notice, change };
}

/** The three switches, and why they may be stuck off. */
function Switches({
  current,
  busy,
  change,
}: Readonly<{
  current: Marketing;
  busy: boolean;
  change: (channel: MarketingChannel, on: boolean) => Promise<void>;
}>) {
  const { t } = useI18n();
  const ticks = ticksOf(current);
  return (
    <>
      {current.canOptIn ? null : <AppText muted>{t("marketing.ageLimited")}</AppText>}
      {MARKETING_CHANNELS.map((channel) => (
        <ChannelRow
          key={channel}
          channel={channel}
          on={ticks[channel]}
          disabled={busy || (!current.canOptIn && !ticks[channel])}
          onChange={(on) => void change(channel, on)}
        />
      ))}
      <AppText muted>{t("marketing.stop")}</AppText>
    </>
  );
}

/**
 * Settings → Offers and notifications (FR-736, FR-1114): the three channels, each saved the moment its switch moves, so
 * turning one off is as easy as turning it on. One save runs at a time; a failed save leaves the switch where the
 * server last had it.
 */
export function NotificationsScreen() {
  const { t } = useI18n();
  const read = useRead(() => fetchMarketing(api.session), []);
  const { current, busy, notice, change } = useChannelSave(read.data);
  return (
    <Screen title={t("marketing.settingsTitle")} header={<BackButton />}>
      <ScrollView contentContainerStyle={{ gap: 16 }}>
        <AppText muted>{t("marketing.settingsIntro")}</AppText>
        {read.failed && current === null ? (
          <>
            <AppText accessibilityRole="alert">{t("marketing.loadFailed")}</AppText>
            <Button kind="quiet" label={t("common.retry")} onPress={read.retry} />
          </>
        ) : null}
        {current === null ? null : <Switches current={current} busy={busy} change={change} />}
        {notice === null ? null : (
          <AppText accessibilityRole="alert" accessibilityLiveRegion="polite">
            {t(notice)}
          </AppText>
        )}
      </ScrollView>
    </Screen>
  );
}
