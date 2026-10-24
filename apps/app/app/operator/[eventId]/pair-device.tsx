import type { LocalizedText } from "@questify/shared";
import { CameraView, useCameraPermissions } from "expo-camera";
import { useCallback, useEffect, useRef, useState } from "react";
import { ScrollView, View } from "react-native";
import { api } from "#src/api/app-session.ts";
import { randomUuid } from "#src/api/uuid.ts";
import { AppText } from "#src/components/AppText.tsx";
import { BackButton } from "#src/components/BackButton.tsx";
import { PermissionCard, useCameraActive } from "#src/components/Camera.tsx";
import { Button, Field } from "#src/components/Controls.tsx";
import { Screen } from "#src/components/Screen.tsx";
import { questCodeOrigin } from "#src/event/scan.ts";
import { useI18n } from "#src/i18n/provider.tsx";
import { textIn } from "#src/i18n/text.ts";
import {
  claimDevice,
  fetchDevices,
  pairingCodeOf,
  previewDevice,
  scannedPairingCode,
  type DevicesPage,
  type Failed,
  type Preview,
} from "#src/operator/devices.ts";
import { useOperator } from "#src/operator/OperatorContext.tsx";

const EXTRA_ORIGIN = questCodeOrigin(process.env["EXPO_PUBLIC_QUEST_CODE_ORIGIN"], __DEV__);

/** Where the pairing stands: entering the code, the code checked (and its claim key), or done. */
type Step =
  | Readonly<{ kind: "code" }>
  | Readonly<{ kind: "checked"; code: string; preview: Preview; key: string }>
  | Readonly<{ kind: "done"; label: string; kiosk: boolean }>;

const KIND_KEYS = {
  station: "device.kind.station",
  kiosk: "device.kind.kiosk",
  screen: "device.kind.screen",
} as const;

/** The camera reading a pairing page's QR; only a Questify `/pair#` address is taken. */
function PairScanner({ onCode }: Readonly<{ onCode: (code: string) => void }>) {
  const { t } = useI18n();
  const [permission, requestPermission] = useCameraPermissions();
  const active = useCameraActive();
  const [failed, setFailed] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const seen = useRef<string | null>(null);
  if (permission === null) {
    return null;
  }
  if (!permission.granted) {
    return (
      <PermissionCard
        canAskAgain={permission.canAskAgain}
        onAllow={() => void requestPermission()}
      />
    );
  }
  return (
    <>
      <AppText muted>{t("operator.devices.scan")}</AppText>
      {active && !failed ? (
        <View style={{ height: 260, borderRadius: 12, overflow: "hidden" }}>
          <CameraView
            style={{ flex: 1 }}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
            onBarcodeScanned={({ data }) => {
              if (seen.current === data) {
                return;
              }
              seen.current = data;
              const code = scannedPairingCode(data, EXTRA_ORIGIN);
              if (code === null) {
                setNotice(t("operator.devices.notPair"));
              } else {
                onCode(code);
              }
            }}
            onMountError={() => setFailed(true)}
          />
        </View>
      ) : null}
      {failed ? <AppText accessibilityRole="alert">{t("scanner.cameraFailed")}</AppText> : null}
      {notice === null ? null : <AppText accessibilityRole="alert">{notice}</AppText>}
    </>
  );
}

/** The confirm step: what the screen said it is, its quest and label, then Pair. */
function ConfirmPairing({
  step,
  quests,
  busy,
  onPair,
}: Readonly<{
  step: Extract<Step, { kind: "checked" }>;
  quests: DevicesPage;
  busy: boolean;
  onPair: (questId: string, label: string) => void;
}>) {
  const { t, language } = useI18n();
  const [questId, setQuestId] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  if (step.preview.kind === "screen") {
    return <AppText accessibilityRole="alert">{t("operator.devices.stationsOnly")}</AppText>;
  }
  const kiosk = step.preview.kind === "kiosk";
  const choices = kiosk ? quests.kioskQuests : quests.quests;
  return (
    <>
      <AppText variant="title">{t(KIND_KEYS[step.preview.kind])}</AppText>
      <AppText>
        {step.preview.client === ""
          ? t("devices.clientUnknown")
          : t("devices.client", { client: step.preview.client })}
      </AppText>
      {choices.length === 0 ? (
        <AppText>
          {t(kiosk ? "operator.devices.noKioskQuests" : "operator.devices.noQuests")}
        </AppText>
      ) : null}
      {choices.length === 0 ? null : <AppText variant="label">{t("devices.quest")}</AppText>}
      {choices.map((quest) => (
        <Button
          key={quest.id}
          kind={quest.id === questId ? "primary" : "quiet"}
          label={textIn(quest.title, language)}
          onPress={() => setQuestId(quest.id)}
        />
      ))}
      <Field
        label={t("devices.label")}
        placeholder={t("devices.labelHint")}
        value={label}
        onChangeText={setLabel}
        maxLength={40}
      />
      <Button
        label={t("devices.confirm")}
        disabled={busy || questId === null || label.trim() === ""}
        onPress={() => questId !== null && onPair(questId, label)}
      />
    </>
  );
}

/**
 * Staff mode's Pair a device (T-309, FR-1713, ADR-239): scan the QR a station or kiosk page shows, or type its code; see
 * what the screen said it is, pick the quest (one with the screen QR for a station, the kiosk for a kiosk, inside the
 * operator's limit) and a label, and pair. Big screens are paired from the dashboard only.
 */
export default function PairDeviceScreen() {
  const { t, language } = useI18n();
  const { eventId } = useOperator();
  const [typed, setTyped] = useState("");
  const [step, setStep] = useState<Step>({ kind: "code" });
  const [quests, setQuests] = useState<DevicesPage>({ devices: [], quests: [], kioskQuests: [] });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<LocalizedText | "network" | null>(null);

  useEffect(() => {
    void fetchDevices(api.session, eventId).then((answer) => {
      if (answer.kind === "page") {
        setQuests(answer.page);
      }
    });
  }, [eventId]);

  const failed = (answer: Failed) =>
    setProblem(answer.kind === "refused" && answer.message !== null ? answer.message : "network");
  const check = useCallback(
    async (code: string) => {
      setBusy(true);
      setProblem(null);
      const answer = await previewDevice(api.session, eventId, code);
      setBusy(false);
      if (answer.kind === "preview") {
        setStep({ kind: "checked", code, preview: answer.preview, key: randomUuid() });
      } else {
        failed(answer);
      }
    },
    [eventId],
  );
  const pair = async (
    checked: Extract<Step, { kind: "checked" }>,
    questId: string,
    label: string,
  ) => {
    setBusy(true);
    setProblem(null);
    const claim = { code: checked.code, kind: checked.preview.kind, questId, label };
    const answer = await claimDevice(api.session, eventId, claim, checked.key);
    setBusy(false);
    if (answer.kind === "paired") {
      setStep({ kind: "done", label: label.trim(), kiosk: checked.preview.kind === "kiosk" });
    } else {
      failed(answer);
    }
  };
  const code = pairingCodeOf(typed);

  return (
    <Screen title={t("operator.devices.pair")} header={<BackButton />}>
      <ScrollView contentContainerStyle={{ gap: 12 }}>
        {step.kind === "code" ? (
          <>
            <PairScanner onCode={(scanned) => void check(scanned)} />
            <Field
              label={t("devices.code")}
              value={typed}
              onChangeText={setTyped}
              autoCapitalize="characters"
              autoCorrect={false}
              maxLength={12}
            />
            <Button
              label={t("devices.check")}
              disabled={busy || code === undefined}
              onPress={() => code !== undefined && void check(code)}
            />
          </>
        ) : null}
        {step.kind === "checked" ? (
          <ConfirmPairing
            step={step}
            quests={quests}
            busy={busy}
            onPair={(questId, label) => void pair(step, questId, label)}
          />
        ) : null}
        {step.kind === "done" ? (
          <>
            <AppText variant="title" accessibilityRole="alert">
              {t("operator.devices.done", { label: step.label })}
            </AppText>
            {step.kiosk ? <AppText>{t("devices.kioskTip")}</AppText> : null}
            <Button
              kind="quiet"
              label={t("operator.devices.pair")}
              onPress={() => {
                setTyped("");
                setStep({ kind: "code" });
              }}
            />
          </>
        ) : null}
        {problem === null ? null : (
          <AppText accessibilityRole="alert">
            {problem === "network" ? t("join.network") : problem[language]}
          </AppText>
        )}
      </ScrollView>
    </Screen>
  );
}
