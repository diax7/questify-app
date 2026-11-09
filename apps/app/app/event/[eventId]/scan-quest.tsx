import { DEFAULT_TERMS, formatNumber, type Theme } from "@questify/shared";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Haptics from "expo-haptics";
import { router, useLocalSearchParams } from "expo-router";
import { useReducer, useRef, useState } from "react";
import { Platform, View } from "react-native";
import { api } from "#src/api/app-session.ts";
import { randomUuid } from "#src/api/uuid.ts";
import { AppText } from "#src/components/AppText.tsx";
import { BackButton } from "#src/components/BackButton.tsx";
import { PermissionCard, useCameraActive, useRecheckOnReturn } from "#src/components/Camera.tsx";
import { Button } from "#src/components/Controls.tsx";
import { PopIn, SpinningCoin } from "#src/components/motion.tsx";
import { Screen } from "#src/components/Screen.tsx";
import { cameraPlan, type CameraPlan } from "#src/components/camera-plan.ts";
import { TextLines } from "#src/components/TextLines.tsx";
import { detailsAfter, scanStep, type ScanEvent, type ScanStep } from "#src/event/celebration.ts";
import { beatViewOf, hasNextBeat, pointsLines } from "#src/event/celebration-view.ts";
import { completedBuzz } from "#src/event/completed-buzz.ts";
import { firstBonusLine } from "#src/event/first-bonus.ts";
import { FlameIcon } from "#src/streaks/FlameIcon.tsx";
import { streakBonusLine } from "#src/streaks/event-streak.ts";
import { useEvent, useTerms } from "#src/event/EventContext.tsx";
import { scanReading, type Position } from "#src/event/location.ts";
import { useLocationReader } from "#src/event/LocationEntry.tsx";
import { isMeetCode, scanMeet } from "#src/event/meet.ts";
import { outcomeText } from "#src/event/QuestSheet.tsx";
import {
  completeQuest,
  fetchQuests,
  keyFor,
  type Attempt,
  type CompletionAnswer,
} from "#src/event/quests-api.ts";
import { stampStep } from "#src/event/passport.ts";
import { revealCategory } from "#src/event/reveal.ts";
import { ReviewCodePicker } from "#src/event/ReviewCodePicker.tsx";
import { answerBuzz, answerQuestId, scanDecision } from "#src/event/scan-flow.ts";
import {
  OPEN_GATE,
  categoryIdOf,
  passes,
  questCodeOrigin,
  screenQuestIdOf,
  stepIdOf,
  type ScanGate,
} from "#src/event/scan.ts";
import { useI18n } from "#src/i18n/provider.tsx";
import { textIn } from "#src/i18n/text.ts";
import { NfcTap, type TapRead } from "#src/nfc/NfcTap.tsx";
import { tapTag } from "#src/nfc/nfc-api.ts";
import { tagTokenOf } from "#src/nfc/tag.ts";
import { useThemedStyles } from "#src/theme/theme.tsx";

/** The one extra web origin this build reads quest codes from (a staging demo, or development). */
const EXTRA_ORIGIN = questCodeOrigin(process.env["EXPO_PUBLIC_QUEST_CODE_ORIGIN"], __DEV__);

/**
 * Sends a scanned code: `id` is the quest's, a passport step's for a step's code (T-304b), or a hidden category's for
 * its secret code (T-304c); the token's own layout says which, and a station's rotating code (T-309) is its quest's. Another player's meet code (T-303c) goes whole to
 * `POST /v1/meet`, which names its quest. A quest's code carries the last known position when
 * there is one (T-303b): it never delays the scan, and the server drops a bad one.
 */
const send = (id: string, token: string, key: string, position: Position | null) => {
  if (isMeetCode(token)) {
    return scanMeet(api.session, token, key, position);
  }
  if (categoryIdOf(token) !== null) {
    return revealCategory(api.session, id, token);
  }
  if (stepIdOf(token) !== null) {
    return stampStep(api.session, id, token, key);
  }
  const type = screenQuestIdOf(token) === null ? "qr" : "screen";
  return completeQuest(
    api.session,
    id,
    { type, code: token, ...(position === null ? {} : { position }) },
    key,
  );
};

/** The scanner's placeholder id for a tag: its quest is the server's answer (`questId`). */
const NFC_ID = "nfc";

/** Haptics never block a scan: a phone without them simply stays still. */
const buzz = (run: () => Promise<void>) => void run().catch(() => undefined);

/** The words for a refusal in the scanner: as the quest sheet, and "not available to you" where it would reload. */
function refusalText(
  answer: CompletionAnswer,
  t: ReturnType<typeof useI18n>["t"],
  language: "ar" | "en",
) {
  // A refusal names no amount, so the currency's words are never used here.
  return answer.kind === "reload"
    ? t("scanner.unavailable")
    : (outcomeText(answer, t, language, DEFAULT_TERMS) ?? "");
}

/**
 * Points with the quest's title (which also says which quest a code was for, when the player opened the scanner from
 * another quest), the first-N bonus and the streak bonus as their own beats, then a level-up's medium beat, then (when
 * this scan finished its category) the full-screen category celebration (FR-406, FR-407, `celebrationBeats`).
 */
function Celebration({
  step,
  onClaim,
}: Readonly<{ step: Extract<ScanStep, { kind: "celebrating" }>; onClaim: () => void }>) {
  const { t, language } = useI18n();
  const terms = useTerms();
  const [shown, setShown] = useState(0);
  const view = beatViewOf(step, shown);
  const claim = () => (hasNextBeat(step, shown) ? setShown(shown + 1) : onClaim());
  // Until the quests are read again, the category step and the title are unknown: Claim waits for them.
  const ready = step.details !== undefined;
  switch (view.kind) {
    case "category":
      return (
        <PopIn>
          <SpinningCoin size={120} />
          <AppText variant="display">
            {t("scanner.categoryDone", { name: textIn(view.category.name, language) })}
          </AppText>
          <Button label={t("scanner.claim")} onPress={claim} />
        </PopIn>
      );
    case "firstBonus":
      return (
        <PopIn>
          <SpinningCoin size={120} />
          <AppText variant="display">{firstBonusLine(t, language, view.bonus)}</AppText>
          <Button label={t("scanner.claim")} onPress={claim} />
        </PopIn>
      );
    case "streak":
      return (
        <PopIn>
          <FlameIcon size={120} />
          <AppText variant="display">{streakBonusLine(t, view.bonus)}</AppText>
          <Button label={t("scanner.claim")} onPress={claim} />
        </PopIn>
      );
    case "level":
      return (
        <PopIn>
          <AppText variant="title">{t("level.up")}</AppText>
          <AppText variant="display">{t("level.number", { level: view.levelUp.level })}</AppText>
          <AppText variant="title">{textIn(view.levelUp.title, language)}</AppText>
          {view.levelUp.items?.map((item) => (
            <AppText key={item.id}>{item.name[language]}</AppText>
          ))}
          <Button label={t("common.continue")} onPress={claim} />
        </PopIn>
      );
    case "points":
      return (
        <PopIn>
          <TextLines lines={pointsLines(t, terms, language, step)} />
          <Button label={t("scanner.claim")} disabled={!ready} onPress={claim} />
        </PopIn>
      );
  }
}

/** What the scanner's handlers read and write: the values and refs of the screen they act for. */
type Scanner = Readonly<{
  t: ReturnType<typeof useI18n>["t"];
  eventId: string;
  reader: ReturnType<typeof useLocationReader>;
  scanPositions: boolean;
  gate: { current: ScanGate };
  attempt: { current: Attempt | undefined };
  tagUid: { current: string | null };
  dispatch: (event: ScanEvent) => void;
  setNotice: (notice: string | null) => void;
}>;

/** Asks the server about a code: a tag by its tap, anything else by `send`. */
const ask = (scanner: Scanner, id: string, token: string, key: string, position: Position | null) =>
  id === NFC_ID
    ? tapTag(
        api.session,
        {
          code: token,
          uid: scanner.tagUid.current,
          platform: Platform.OS === "ios" ? "ios" : "android",
          position,
        },
        key,
      )
    : send(id, token, key, position);

type Completed = Extract<Awaited<ReturnType<typeof ask>>, { kind: "completed" }>;

/** A completion's buzz, then the quests read again for its title and finished category. */
async function finishCompleted(scanner: Scanner, id: string, answer: Completed) {
  buzz(() => completedBuzz(answer));
  const quests = await fetchQuests(api.session, scanner.eventId);
  scanner.dispatch({
    type: "details",
    details: detailsAfter(
      quests.kind === "quests" ? quests.view : undefined,
      answerQuestId(answer, id),
      answer.replayed,
    ),
  });
}

const BUZZ = {
  success: Haptics.NotificationFeedbackType.Success,
  error: Haptics.NotificationFeedbackType.Error,
} as const;

/** Sends a read code and takes the answer in: the step moves on, the phone buzzes, and a completion reads on. */
async function submitScan(scanner: Scanner, id: string, token: string) {
  const key = keyFor(scanner.attempt.current, token, randomUuid);
  const position = await scanReading(scanner.reader ?? null, scanner.scanPositions, Date.now);
  const answer = await ask(scanner, id, token, key, position);
  scanner.attempt.current = { key, code: token, retryable: answer.kind === "network" };
  if (answer.kind === "signed_out") {
    router.replace("/home");
    return;
  }
  scanner.dispatch({ type: "answered", answer });
  if (answer.kind === "completed") {
    await finishCompleted(scanner, id, answer);
    return;
  }
  const feel = answerBuzz(answer.kind);
  if (feel !== "none") {
    buzz(() => Haptics.notificationAsync(BUZZ[feel]));
  }
}

/** A camera read: gated, then an operator code, a join link, something else (said once), or a code to send. */
function handleScan(scanner: Scanner, data: string) {
  if (!passes(scanner.gate.current, data)) {
    return;
  }
  const decision = scanDecision(data, EXTRA_ORIGIN);
  if (decision.kind === "other") {
    scanner.gate.current = { busy: false, ignored: data };
    scanner.setNotice(scanner.t("scanner.notQuestify"));
    buzz(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning));
    return;
  }
  scanner.gate.current = { busy: true, ignored: null };
  if (decision.kind === "invite") {
    // A personal operator code (T-204) opens its confirm screen.
    router.replace(`/operator-invite/${decision.token}`);
    return;
  }
  scanner.setNotice(null);
  if (decision.kind === "join") {
    router.replace({ pathname: "/join/[code]", params: { code: decision.code, via: "qr" } });
    return;
  }
  buzz(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light));
  scanner.dispatch({ type: "read", questId: decision.id, token: decision.token });
  void submitScan(scanner, decision.id, decision.token);
}

/** A tag read in the scanner (FR-621): only a Questify tag URL read from a tag counts, never a typed or shared link. */
function handleTap(scanner: Scanner, read: TapRead) {
  if (!passes(scanner.gate.current, read.url ?? "")) {
    return;
  }
  const token = tagTokenOf(read.url, EXTRA_ORIGIN);
  if (token === null) {
    scanner.setNotice(scanner.t("scanner.nfc.notQuestify"));
    buzz(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning));
    return;
  }
  scanner.gate.current = { busy: true, ignored: null };
  scanner.setNotice(null);
  scanner.tagUid.current = read.uid;
  buzz(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light));
  scanner.dispatch({ type: "read", questId: NFC_ID, token });
  void submitScan(scanner, NFC_ID, token);
}

/** The camera area: the permission wait, its card, the live camera, and the note when the camera failed to start. */
function ScanCamera({
  plan,
  cameraFailed,
  onAllow,
  onScanned,
  onMountError,
}: Readonly<{
  plan: CameraPlan;
  cameraFailed: boolean;
  onAllow: () => void;
  onScanned: (read: { data: string }) => void;
  onMountError: () => void;
}>) {
  const { t } = useI18n();
  const styles = useThemedStyles(makeStyles);
  return (
    <>
      {plan.loading ? <AppText muted>{t("common.loading")}</AppText> : null}
      {plan.ask === null ? null : (
        <PermissionCard canAskAgain={plan.ask.canAskAgain} onAllow={onAllow} />
      )}
      {plan.camera ? (
        <View style={styles.camera}>
          <CameraView
            style={{ flex: 1 }}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
            onBarcodeScanned={onScanned}
            onMountError={onMountError}
          />
        </View>
      ) : null}
      {cameraFailed ? (
        <AppText accessibilityRole="alert">{t("scanner.cameraFailed")}</AppText>
      ) : null}
    </>
  );
}

/** A passport step's stamp: how far along the passport is. */
function StampedResult({
  step,
  onAgain,
}: Readonly<{ step: Extract<ScanStep, { kind: "stamped" }>; onAgain: () => void }>) {
  const { t, language } = useI18n();
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.result}>
      <PopIn>
        <AppText variant="display" accessibilityRole="alert">
          {t(step.fresh ? "scanner.stamped" : "scanner.stampedBefore", {
            done: formatNumber(step.done, language),
            needed: formatNumber(step.needed, language),
          })}
        </AppText>
      </PopIn>
      <Button label={t("scanner.again")} onPress={onAgain} />
      <Button kind="quiet" label={t("common.close")} onPress={() => router.back()} />
    </View>
  );
}

/** A hidden category found by its secret code. */
function RevealedResult({
  step,
  onAgain,
}: Readonly<{ step: Extract<ScanStep, { kind: "revealed" }>; onAgain: () => void }>) {
  const { t, language } = useI18n();
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.result}>
      <PopIn>
        <AppText variant="display" accessibilityRole="alert">
          {t(step.fresh ? "scanner.revealed" : "scanner.revealedBefore", {
            name: textIn(step.name, language),
          })}
        </AppText>
      </PopIn>
      {step.fresh ? <AppText>{t("scanner.revealedBody")}</AppText> : null}
      <Button label={t("common.close")} onPress={() => router.back()} />
      <Button kind="quiet" label={t("scanner.again")} onPress={onAgain} />
    </View>
  );
}

/** The step below the camera: the "Checking…" beat, the celebration, a stamp, a find, a refusal or a lost answer. */
function ScanResult({
  step,
  onAgain,
  onRetry,
}: Readonly<{ step: ScanStep; onAgain: () => void; onRetry: () => void }>) {
  const { t, language } = useI18n();
  const styles = useThemedStyles(makeStyles);
  switch (step.kind) {
    case "checking":
      return (
        <View style={styles.result}>
          <SpinningCoin />
          <AppText variant="title" accessibilityRole="alert">
            {t("scanner.checking")}
          </AppText>
        </View>
      );
    case "celebrating":
      return <Celebration step={step} onClaim={() => router.back()} />;
    case "stamped":
      return <StampedResult step={step} onAgain={onAgain} />;
    case "revealed":
      return <RevealedResult step={step} onAgain={onAgain} />;
    case "refused":
      return (
        <View style={styles.result}>
          <AppText variant="title" accessibilityRole="alert">
            {refusalText(step.answer, t, language)}
          </AppText>
          <Button label={t("scanner.again")} onPress={onAgain} />
        </View>
      );
    case "lost":
      return (
        <View style={styles.result}>
          <AppText accessibilityRole="alert">{t("join.network")}</AppText>
          <Button label={t("common.retry")} onPress={onRetry} />
          <Button kind="quiet" label={t("scanner.again")} onPress={onAgain} />
        </View>
      );
    case "scanning":
      return null;
  }
}

/**
 * The scanner (FR-201, FR-303, FR-406, FR-621): the live camera only, never an image from the gallery. A read shows
 * "Scanned! Checking…" at once, then the server's answer: the points, or the reason in clear words. One scan at a time;
 * the same unrecognised code is reported once. The server verifies every code; the app only reads the quest id.
 */
export default function ScanQuestScreen() {
  const { t } = useI18n();
  const { eventId, scanPositions, nfcOn } = useEvent();
  const { nfc } = useLocalSearchParams<{ nfc?: string }>();
  const reader = useLocationReader();
  const [permission, requestPermission, getPermission] = useCameraPermissions();
  const active = useCameraActive();
  const [step, dispatch] = useReducer(scanStep, { kind: "scanning" });
  const [notice, setNotice] = useState<string | null>(null);
  const [cameraFailed, setCameraFailed] = useState(false);
  const gate = useRef<ScanGate>(OPEN_GATE);
  const attempt = useRef<Attempt | undefined>(undefined);
  const tagUid = useRef<string | null>(null);

  useRecheckOnReturn(getPermission);

  const scanner: Scanner = {
    t,
    eventId,
    reader,
    scanPositions,
    gate,
    attempt,
    tagUid,
    dispatch,
    setNotice,
  };
  const scanned = ({ data }: { data: string }) => handleScan(scanner, data);
  const tapped = (read: TapRead) => handleTap(scanner, read);

  // The last attempt stays: rescanning the same code after a lost answer reuses its key (`keyFor`), so it never pays
  // twice; any answer from the server already made the next key new.
  const again = () => {
    gate.current = OPEN_GATE;
    setNotice(null);
    dispatch({ type: "again" });
  };
  const retry = () => {
    if (step.kind === "lost") {
      dispatch({ type: "retry" });
      void submitScan(scanner, step.questId, step.token);
    }
  };

  const scanning = step.kind === "scanning";
  const plan = cameraPlan(permission, true, scanning && active && !cameraFailed);
  return (
    <Screen title={t("scanner.title")} header={<BackButton />}>
      {/* FR-306, FR-622: My QR sits behind the same round button. */}
      <Button kind="quiet" label={t("myQr.title")} onPress={() => router.push("/my-qr")} />
      <ReviewCodePicker eventId={eventId} disabled={!scanning} onScan={scanned} />
      {nfcOn ? <NfcTap active={scanning} autoStart={nfc === "1"} onRead={tapped} /> : null}
      <ScanCamera
        plan={plan}
        cameraFailed={cameraFailed}
        onAllow={() => void requestPermission()}
        onScanned={scanned}
        onMountError={() => setCameraFailed(true)}
      />
      {notice === null ? null : <AppText accessibilityRole="alert">{notice}</AppText>}
      <ScanResult step={step} onAgain={again} onRetry={retry} />
    </Screen>
  );
}

const makeStyles = (theme: Theme) => ({
  camera: {
    flex: 1,
    maxHeight: 420,
    overflow: "hidden" as const,
    borderRadius: theme.radius.lg,
    borderWidth: 3,
    borderColor: theme.colors.border,
  },
  result: { gap: theme.spacing.md, alignItems: "center" as const },
});
