import type { Theme } from "@questify/shared";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { Linking, Modal, View } from "react-native";
import { api } from "#src/api/app-session.ts";
import { randomUuid } from "#src/api/uuid.ts";
import { AppText } from "#src/components/AppText.tsx";
import { Button } from "#src/components/Controls.tsx";
import { sheetOpened } from "#src/components/sheet-count.ts";
import { useEvent } from "#src/event/EventContext.tsx";
import { checkInRead, nativeReader, type LocationReader } from "#src/event/location.ts";
import { completeQuest, type CompletionAnswer, type Quest } from "#src/event/quests-api.ts";
import { useI18n } from "#src/i18n/provider.tsx";
import { useThemedStyles } from "#src/theme/theme.tsx";

let shared: Promise<LocationReader | null> | undefined;

/** The phone's location module, loaded once on first use; null in a build without it. */
export function useLocationReader(): LocationReader | null | undefined {
  const [reader, setReader] = useState<LocationReader | null | undefined>(undefined);
  useEffect(() => {
    let current = true;
    shared ??= nativeReader();
    void shared.then((loaded) => {
      if (current) {
        setReader(loaded);
      }
    });
    return () => {
      current = false;
    };
  }, []);
  return reader;
}

/**
 * Why Questify reads location, with one button, "Continue", that always opens the system prompt (ADR-208; Apple 5.1.1
 * (iv): no "Not now" and no close on this message).
 */
export function LocationExplanation({ onContinue }: Readonly<{ onContinue: () => void }>) {
  const { t } = useI18n();
  return (
    <>
      <AppText variant="label" accessibilityRole="header">
        {t("location.explainTitle")}
      </AppText>
      <AppText>{t("location.explainBody")}</AppText>
      <Button label={t("location.continue")} onPress={onContinue} />
    </>
  );
}

/** The explanation on its own, shown once after joining an in-person event with a venue pin. */
export function LocationPrompt({
  visible,
  onContinue,
}: Readonly<{ visible: boolean; onContinue: () => void }>) {
  const styles = useThemedStyles(makeStyles);
  const { rtl } = useI18n();
  // A sheet of its own: the live poll card waits while it is open (T-306).
  useEffect(() => (visible ? sheetOpened() : undefined), [visible]);
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onContinue}>
      <View style={styles.backdrop}>
        <View style={[styles.sheet, { direction: rtl ? "rtl" : "ltr" }]}>
          <LocationExplanation onContinue={onContinue} />
        </View>
      </View>
    </Modal>
  );
}

const makeStyles = (theme: Theme) => ({
  backdrop: { flex: 1, justifyContent: "flex-end" as const },
  sheet: {
    gap: theme.spacing.md,
    padding: theme.spacing.xl,
    borderTopLeftRadius: theme.radius.lg,
    borderTopRightRadius: theme.radius.lg,
    backgroundColor: theme.colors.background,
  },
});

type Said = Readonly<{ text: string; settings: boolean }>;

/**
 * A location quest in the quest sheet (FR-215, FR-216): "Check in here" reads a fresh position and sends it; the QR
 * at the spot is always offered beside it. Asking happens only through the explanation's Continue. While the
 * platform's switch is off, or in a build without the location module, only the QR is offered.
 */
export function LocationEntry({
  quest,
  onDone,
}: Readonly<{ quest: Quest; onDone: (answer: CompletionAnswer) => void }>) {
  const { t } = useI18n();
  const { eventId, locationOn } = useEvent();
  const reader = useLocationReader();
  const [explaining, setExplaining] = useState(false);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<Said | null>(null);
  if (quest.state !== "open") {
    return null;
  }
  const checkIn = async () => {
    setSaid(null);
    setBusy(true);
    const read = await checkInRead(reader ?? null, Date.now);
    if (read.kind !== "position") {
      setBusy(false);
      if (read.kind === "ask") {
        setExplaining(true);
        return;
      }
      const text = { denied: "location.denied", timeout: "location.timeout" } as const;
      setSaid({
        text: t(read.kind === "unavailable" ? "location.unavailable" : text[read.kind]),
        settings: read.kind === "denied",
      });
      return;
    }
    const answer = await completeQuest(
      api.session,
      quest.id,
      { type: "location", position: read.position },
      randomUuid(),
    );
    setBusy(false);
    onDone(answer);
  };
  const ask = async () => {
    setExplaining(false);
    const permission = reader === null || reader === undefined ? "denied" : await reader.ask();
    if (permission === "granted") {
      await checkIn();
    } else {
      setSaid({ text: t("location.denied"), settings: true });
    }
  };
  const scan = (
    <Button
      kind={locationOn && reader !== null ? "quiet" : "primary"}
      label={t("questsTab.scan")}
      onPress={() =>
        router.push({
          pathname: "/event/[eventId]/scan-quest",
          params: { eventId, quest: quest.id },
        })
      }
    />
  );
  if (!locationOn || reader === null) {
    return (
      <>
        <AppText variant="label">{t("questsTab.verifyScan")}</AppText>
        {scan}
      </>
    );
  }
  if (explaining) {
    return <LocationExplanation onContinue={() => void ask()} />;
  }
  return (
    <>
      {said === null ? null : <AppText accessibilityRole="alert">{said.text}</AppText>}
      {said?.settings === true ? (
        <Button
          kind="quiet"
          label={t("location.openSettings")}
          onPress={() => void Linking.openSettings().catch(() => undefined)}
        />
      ) : null}
      {busy ? <AppText muted>{t("location.checking")}</AppText> : null}
      <Button
        label={t("location.checkIn")}
        disabled={busy || reader === undefined}
        onPress={() => void checkIn()}
      />
      {scan}
    </>
  );
}
