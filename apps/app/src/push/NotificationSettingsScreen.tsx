import { PUSH_TOPICS, type OwnPushTopics, type PushTopic } from "@questify/shared";
import { useEffect, useState } from "react";
import { Linking, ScrollView, View } from "react-native";
import { api } from "#src/api/app-session.ts";
import { AppText } from "#src/components/AppText.tsx";
import { BackButton } from "#src/components/BackButton.tsx";
import { Button } from "#src/components/Controls.tsx";
import { Screen } from "#src/components/Screen.tsx";
import { InfoTip } from "#src/components/InfoTip.tsx";
import { SwitchRow } from "#src/components/SwitchRow.tsx";
import { useI18n } from "#src/i18n/provider.tsx";
import { OffersSection } from "#src/marketing/OffersSection.tsx";
import { fetchTopics, saveTopics } from "#src/push/push-api.ts";
import { TOPIC_TEXT, withTopic } from "#src/push/topics.ts";
import { usePhonePush } from "#src/push/use-permission.ts";
import { useRead } from "#src/questify/use-read.ts";

/**
 * Whether this phone shows pushes (FR-1105). A refused permission blocks nothing: the line says so, the center still
 * holds every message, and the topics below stay usable (they apply when push is on). No nagging: the only ways to
 * change it are the buttons here.
 */
function PhoneStatus() {
  const { t } = useI18n();
  const { state, ask } = usePhonePush();
  if (state === "loading") return null;
  return (
    <>
      <AppText variant="title">{t("pushSettings.title")}</AppText>
      {state === "unavailable" ? <AppText muted>{t("pushSettings.unavailable")}</AppText> : null}
      {state === "granted" ? <AppText>{t("pushSettings.on")}</AppText> : null}
      {state === "denied" || state === "undetermined" ? (
        <>
          <AppText>{t("pushSettings.off")}</AppText>
          <AppText muted>{t("pushSettings.offAbout")}</AppText>
          <Button
            kind="quiet"
            label={t(state === "denied" ? "pushSettings.openPhone" : "pushSettings.ask")}
            onPress={state === "denied" ? () => void Linking.openSettings() : ask}
          />
        </>
      ) : null}
    </>
  );
}

/** The four topics, each saved the moment its switch moves; a failed save puts the switch back where the server had it. */
function useTopicSave(fresh: OwnPushTopics | null) {
  const [saved, setSaved] = useState<OwnPushTopics | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  // A fresher read (the screen gained focus again) replaces what an earlier save here left.
  useEffect(() => setSaved(null), [fresh]);
  const current = saved ?? fresh;
  const change = async (topic: PushTopic, on: boolean) => {
    if (busy || current === null) return;
    setBusy(true);
    setFailed(false);
    setSaved(withTopic(current, topic, on));
    const answer = await saveTopics(api.session, { [topic]: on });
    setSaved(answer ?? current);
    setFailed(answer === null);
    setBusy(false);
  };
  return { current, busy, failed, change };
}

/** The topic switches (FR-1115): a muted topic stops the push and keeps the message in the center. */
function TopicSwitches() {
  const { t } = useI18n();
  const read = useRead(() => fetchTopics(api.session), []);
  const { current, busy, failed, change } = useTopicSave(read.data);
  return (
    <>
      <InfoTip info={t("pushTopics.intro")} subject={t("pushTopics.title")}>
        <AppText variant="title">{t("pushTopics.title")}</AppText>
      </InfoTip>
      {read.failed && current === null ? (
        <>
          <AppText accessibilityRole="alert">{t("pushTopics.loadFailed")}</AppText>
          <Button kind="quiet" label={t("common.retry")} onPress={read.retry} />
        </>
      ) : null}
      {current === null
        ? null
        : PUSH_TOPICS.map((topic) => (
            <View key={topic} style={{ gap: 4 }}>
              <SwitchRow
                title={TOPIC_TEXT[topic].title}
                about={TOPIC_TEXT[topic].about}
                on={current[topic]}
                disabled={busy}
                onChange={(on) => void change(topic, on)}
              />
              {current.eventOff.includes(topic) ? (
                <AppText muted>{t("pushTopics.eventOff")}</AppText>
              ) : null}
            </View>
          ))}
      <AppText muted>{t("pushTopics.always")}</AppText>
      {failed ? (
        <AppText accessibilityRole="alert" accessibilityLiveRegion="polite">
          {t("marketing.failed")}
        </AppText>
      ) : null}
    </>
  );
}

/**
 * Settings → Offers and notifications (FR-736, FR-1105, FR-1114, FR-1115): this phone's push status, the four topics
 * and the promotional channels.
 */
export function NotificationSettingsScreen() {
  const { t } = useI18n();
  return (
    <Screen title={t("marketing.settingsTitle")} header={<BackButton />}>
      <ScrollView contentContainerStyle={{ gap: 16 }}>
        <PhoneStatus />
        <TopicSwitches />
        <OffersSection />
      </ScrollView>
    </Screen>
  );
}
