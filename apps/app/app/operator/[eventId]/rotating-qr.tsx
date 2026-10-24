import { formatNumber } from "@questify/shared";
import { useKeepAwake } from "expo-keep-awake";
import { useEffect, useState } from "react";
import { ScrollView, useWindowDimensions, View } from "react-native";
import { api } from "#src/api/app-session.ts";
import { AppText } from "#src/components/AppText.tsx";
import { BackButton } from "#src/components/BackButton.tsx";
import { Button } from "#src/components/Controls.tsx";
import { QrCode } from "#src/components/QrCode.tsx";
import { Screen } from "#src/components/Screen.tsx";
import { useI18n } from "#src/i18n/provider.tsx";
import { textIn } from "#src/i18n/text.ts";
import {
  codeGraceMs,
  fetchDevices,
  fetchScreenCode,
  nextCodeDelayMs,
  shutKey,
  type StationQuest,
} from "#src/operator/devices.ts";
import { useOperator } from "#src/operator/OperatorContext.tsx";

const RETRY_MS = 3000;

/** What the phone shows: a code (and when it was fetched), why there is none, or a lost connection. */
type Shown =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "code"; url: string; changesInMs: number; at: number }>
  | Readonly<{ kind: "shut"; shut: string }>
  | Readonly<{ kind: "reconnecting" }>
  | Readonly<{ kind: "refused"; text: string }>;

/**
 * The code loop for one quest (FR-314): fetch, show, fetch again when it changes plus jitter, timed from each answer.
 * Without an answer the code stays only until its grace ends, then "Reconnecting…" and no code.
 */
function useOperatorCode(eventId: string, questId: string): Shown {
  const { language } = useI18n();
  const [shown, setShown] = useState<Shown>({ kind: "loading" });
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let held: Extract<Shown, { kind: "code" }> | undefined;
    const later = (ms: number) => {
      timer = setTimeout(() => void read(), ms);
    };
    const read = async () => {
      const answer = await fetchScreenCode(api.session, eventId, questId);
      if (stopped) {
        return;
      }
      if (answer.kind === "code") {
        held = { kind: "code", url: answer.url, changesInMs: answer.changesInMs, at: Date.now() };
        setShown(held);
        later(nextCodeDelayMs(answer.changesInMs, Math.random()));
      } else if (answer.kind === "shut") {
        held = undefined;
        setShown({ kind: "shut", shut: answer.shut });
        later(RETRY_MS);
      } else if (answer.kind === "refused" && answer.message !== null) {
        setShown({ kind: "refused", text: answer.message[language] });
      } else {
        const alive = held !== undefined && Date.now() - held.at < codeGraceMs(held.changesInMs);
        setShown(alive && held !== undefined ? held : { kind: "reconnecting" });
        later(RETRY_MS);
      }
    };
    void read();
    return () => {
      stopped = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    };
  }, [eventId, questId, language]);
  return shown;
}

/** One quest's code, full width; it changes on its own every 30 seconds. */
function QuestCode({ quest }: Readonly<{ quest: StationQuest }>) {
  const { t, language } = useI18n();
  const { eventId } = useOperator();
  const { width } = useWindowDimensions();
  // The screen stays on while a code is shown (expo-keep-awake ships with Expo; no new native module).
  useKeepAwake();
  const shown = useOperatorCode(eventId, quest.id);
  const size = Math.min(width - 48, 420);
  return (
    <View style={{ alignItems: "center", gap: 12 }}>
      <AppText variant="title">{textIn(quest.title, language)}</AppText>
      <AppText>{t("station.points", { points: formatNumber(quest.points, language) })}</AppText>
      {shown.kind === "code" ? (
        <QrCode text={shown.url} size={size} label={t("station.scan")} />
      ) : null}
      {shown.kind === "shut" ? (
        <AppText accessibilityRole="alert">{t(shutKey(shown.shut))}</AppText>
      ) : null}
      {shown.kind === "reconnecting" ? (
        <AppText accessibilityRole="alert">{t("device.reconnecting")}</AppText>
      ) : null}
      {shown.kind === "refused" ? <AppText accessibilityRole="alert">{shown.text}</AppText> : null}
      {shown.kind === "loading" ? <AppText muted>{t("common.loading")}</AppText> : null}
    </View>
  );
}

/**
 * Staff mode's Rotating QR (FR-314, FR-922): pick a quest with the screen QR (inside the operator's limit, with
 * `show_rotating_qr` on), then its code, which changes every 30 seconds, full screen on the operator's phone.
 */
export default function RotatingQrScreen() {
  const { t, language } = useI18n();
  const { eventId } = useOperator();
  const [quests, setQuests] = useState<readonly StationQuest[] | null>(null);
  const [chosen, setChosen] = useState<StationQuest | null>(null);
  useEffect(() => {
    void fetchDevices(api.session, eventId).then((answer) => {
      setQuests(answer.kind === "page" ? answer.page.quests : []);
    });
  }, [eventId]);
  return (
    <Screen title={t("operator.rotating")} header={<BackButton />}>
      <ScrollView contentContainerStyle={{ gap: 12 }}>
        {quests === null ? <AppText muted>{t("common.loading")}</AppText> : null}
        {quests?.length === 0 ? <AppText>{t("operator.devices.noQuests")}</AppText> : null}
        {chosen === null && quests !== null && quests.length > 0 ? (
          <>
            <AppText variant="label">{t("operator.rotating.pick")}</AppText>
            {quests.map((quest) => (
              <Button
                key={quest.id}
                kind="quiet"
                label={textIn(quest.title, language)}
                onPress={() => setChosen(quest)}
              />
            ))}
          </>
        ) : null}
        {chosen === null ? null : (
          <>
            <QuestCode quest={chosen} />
            <Button
              kind="quiet"
              label={t("operator.rotating.pick")}
              onPress={() => setChosen(null)}
            />
          </>
        )}
      </ScrollView>
    </Screen>
  );
}
