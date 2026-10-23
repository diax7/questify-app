import { DEFAULT_TERMS, formatNumber, type Theme } from "@questify/shared";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import { useEffect, useReducer, useRef, useState } from "react";
import { AppState, View } from "react-native";
import { api } from "#src/api/app-session.ts";
import { randomUuid } from "#src/api/uuid.ts";
import { AppText } from "#src/components/AppText.tsx";
import { BackButton } from "#src/components/BackButton.tsx";
import { PermissionCard, useCameraActive } from "#src/components/Camera.tsx";
import { Button } from "#src/components/Controls.tsx";
import { PopIn, SpinningCoin } from "#src/components/motion.tsx";
import { Screen } from "#src/components/Screen.tsx";
import { celebrationBeats, detailsAfter, scanStep, type ScanStep } from "#src/event/celebration.ts";
import { bonusLine, completedText } from "#src/event/amount.ts";
import { useEvent, useTerms } from "#src/event/EventContext.tsx";
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
import {
  OPEN_GATE,
  categoryIdOf,
  passes,
  questCodeOrigin,
  readScan,
  stepIdOf,
  type ScanGate,
} from "#src/event/scan.ts";
import { inviteTokenOf } from "#src/operator/station.ts";
import { useI18n } from "#src/i18n/provider.tsx";
import { textIn } from "#src/i18n/text.ts";
import { useThemedStyles } from "#src/theme/theme.tsx";

/** The one extra web origin this build reads quest codes from (a staging demo, or development). */
const EXTRA_ORIGIN = questCodeOrigin(process.env["EXPO_PUBLIC_QUEST_CODE_ORIGIN"], __DEV__);

/**
 * Sends a scanned code: `id` is the quest's, a passport step's for a step's code (T-304b), or a hidden category's for
 * its secret code (T-304c); the token's own layout says which.
 */
const send = (id: string, token: string, key: string) => {
  if (categoryIdOf(token) !== null) {
    return revealCategory(api.session, id, token);
  }
  return stepIdOf(token) === null
    ? completeQuest(api.session, id, { type: "qr", code: token }, key)
    : stampStep(api.session, id, token, key);
};

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
 * another quest), then a level-up's medium beat, then (when this scan finished its category) the full-screen category
 * celebration (FR-406, FR-407, `celebrationBeats`). */
function Celebration({
  step,
  onClaim,
}: Readonly<{ step: Extract<ScanStep, { kind: "celebrating" }>; onClaim: () => void }>) {
  const { t, language } = useI18n();
  const terms = useTerms();
  const [shown, setShown] = useState(0);
  const beats = celebrationBeats(step);
  const beat = beats[shown] ?? "points";
  const claim = () => (shown + 1 < beats.length ? setShown(shown + 1) : onClaim());
  // Until the quests are read again, the category step and the title are unknown: Claim waits for them.
  const ready = step.details !== undefined;
  const category = step.details?.finishedCategory;
  if (beat === "category" && category !== undefined) {
    return (
      <PopIn>
        <SpinningCoin size={120} />
        <AppText variant="display">
          {t("scanner.categoryDone", { name: textIn(category.name, language) })}
        </AppText>
        <Button label={t("scanner.claim")} onPress={claim} />
      </PopIn>
    );
  }
  if (beat === "level" && step.levelUp !== null) {
    return (
      <PopIn>
        <AppText variant="title">{t("level.up")}</AppText>
        <AppText variant="display">{t("level.number", { level: step.levelUp.level })}</AppText>
        <AppText variant="title">{textIn(step.levelUp.title, language)}</AppText>
        <Button label={t("common.continue")} onPress={claim} />
      </PopIn>
    );
  }
  const quest = step.details?.quest;
  return (
    <PopIn>
      <AppText variant="display">
        {/* Paid in another event: its words are unknown here, so Questify's own name the amount. */}
        {completedText(t, step.details?.otherEvent ? DEFAULT_TERMS : terms, language, step.points)}
      </AppText>
      {step.bonus === null ? null : (
        <AppText variant="title">{bonusLine(t, language, step.bonus)}</AppText>
      )}
      {quest === undefined ? null : (
        <AppText variant="title">{textIn(quest.title, language)}</AppText>
      )}
      {step.details?.otherEvent ? <AppText>{t("scanner.otherEvent")}</AppText> : null}
      <Button label={t("scanner.claim")} disabled={!ready} onPress={claim} />
    </PopIn>
  );
}

/**
 * The scanner (FR-201, FR-303, FR-406, FR-621): the live camera only, never an image from the gallery. A read shows
 * "Scanned! Checking…" at once, then the server's answer: the points, or the reason in clear words. One scan at a time;
 * the same unrecognised code is reported once. The server verifies every code; the app only reads the quest id.
 */
export default function ScanQuestScreen() {
  const { t, language } = useI18n();
  const { eventId } = useEvent();
  const styles = useThemedStyles(makeStyles);
  const [permission, requestPermission, getPermission] = useCameraPermissions();
  const active = useCameraActive();
  const [step, dispatch] = useReducer(scanStep, { kind: "scanning" });
  const [notice, setNotice] = useState<string | null>(null);
  const [cameraFailed, setCameraFailed] = useState(false);
  const gate = useRef<ScanGate>(OPEN_GATE);
  const attempt = useRef<Attempt | undefined>(undefined);

  // Coming back from Settings re-reads the permission, so allowing it there works without a restart.
  useEffect(() => {
    const watcher = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        void getPermission();
      }
    });
    return () => watcher.remove();
  }, [getPermission]);

  const submit = async (id: string, token: string) => {
    const key = keyFor(attempt.current, token, randomUuid);
    const answer = await send(id, token, key);
    attempt.current = { key, code: token, retryable: answer.kind === "network" };
    if (answer.kind === "signed_out") {
      router.replace("/home");
      return;
    }
    dispatch({ type: "answered", answer });
    if (answer.kind === "stamped" || answer.kind === "revealed") {
      buzz(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success));
    } else if (answer.kind === "completed") {
      buzz(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success));
      const quests = await fetchQuests(api.session, eventId);
      dispatch({
        type: "details",
        details: detailsAfter(
          quests.kind === "quests" ? quests.view : undefined,
          "questId" in answer && typeof answer.questId === "string" ? answer.questId : id,
          answer.replayed,
        ),
      });
    } else if (answer.kind !== "network") {
      buzz(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error));
    }
  };

  const scanned = ({ data }: { data: string }) => {
    if (!passes(gate.current, data)) {
      return;
    }
    // A personal operator code (T-204) opens its confirm screen.
    const invite = inviteTokenOf(data);
    if (invite !== null) {
      gate.current = { busy: true, ignored: null };
      router.replace(`/operator-invite/${invite}`);
      return;
    }
    const scan = readScan(data, EXTRA_ORIGIN);
    if (scan.kind === "other") {
      gate.current = { busy: false, ignored: data };
      setNotice(t("scanner.notQuestify"));
      buzz(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning));
      return;
    }
    gate.current = { busy: true, ignored: null };
    setNotice(null);
    if (scan.kind === "join") {
      router.replace({ pathname: "/join/[code]", params: { code: scan.code, via: "qr" } });
      return;
    }
    buzz(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light));
    const id =
      scan.kind === "step" ? scan.stepId : scan.kind === "reveal" ? scan.categoryId : scan.questId;
    dispatch({ type: "read", questId: id, token: scan.token });
    void submit(id, scan.token);
  };

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
      void submit(step.questId, step.token);
    }
  };

  const granted = permission?.granted === true;
  const scanning = step.kind === "scanning";
  return (
    <Screen title={t("scanner.title")} header={<BackButton />}>
      {/* FR-306, FR-622: My QR sits behind the same round button. */}
      <Button kind="quiet" label={t("myQr.title")} onPress={() => router.push("/my-qr")} />
      {permission === null ? <AppText muted>{t("common.loading")}</AppText> : null}
      {permission !== null && !granted ? (
        <PermissionCard
          canAskAgain={permission.canAskAgain}
          onAllow={() => void requestPermission()}
        />
      ) : null}
      {granted && scanning && active && !cameraFailed ? (
        <View style={styles.camera}>
          <CameraView
            style={{ flex: 1 }}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
            onBarcodeScanned={scanning ? scanned : undefined}
            onMountError={() => setCameraFailed(true)}
          />
        </View>
      ) : null}
      {cameraFailed ? (
        <AppText accessibilityRole="alert">{t("scanner.cameraFailed")}</AppText>
      ) : null}
      {notice === null ? null : <AppText accessibilityRole="alert">{notice}</AppText>}
      {step.kind === "checking" ? (
        <View style={styles.result}>
          <SpinningCoin />
          <AppText variant="title" accessibilityRole="alert">
            {t("scanner.checking")}
          </AppText>
        </View>
      ) : null}
      {step.kind === "celebrating" ? (
        <Celebration step={step} onClaim={() => router.back()} />
      ) : null}
      {step.kind === "stamped" ? (
        <View style={styles.result}>
          <PopIn>
            <AppText variant="display" accessibilityRole="alert">
              {t(step.fresh ? "scanner.stamped" : "scanner.stampedBefore", {
                done: formatNumber(step.done, language),
                needed: formatNumber(step.needed, language),
              })}
            </AppText>
          </PopIn>
          <Button label={t("scanner.again")} onPress={again} />
          <Button kind="quiet" label={t("common.close")} onPress={() => router.back()} />
        </View>
      ) : null}
      {step.kind === "revealed" ? (
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
          <Button kind="quiet" label={t("scanner.again")} onPress={again} />
        </View>
      ) : null}
      {step.kind === "refused" ? (
        <View style={styles.result}>
          <AppText variant="title" accessibilityRole="alert">
            {refusalText(step.answer, t, language)}
          </AppText>
          <Button label={t("scanner.again")} onPress={again} />
        </View>
      ) : null}
      {step.kind === "lost" ? (
        <View style={styles.result}>
          <AppText accessibilityRole="alert">{t("join.network")}</AppText>
          <Button label={t("common.retry")} onPress={retry} />
          <Button kind="quiet" label={t("scanner.again")} onPress={again} />
        </View>
      ) : null}
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
