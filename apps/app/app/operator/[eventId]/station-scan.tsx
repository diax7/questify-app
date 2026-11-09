import { formatNumber, type Theme } from "@questify/shared";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { AppState, View, type StyleProp, type TextStyle } from "react-native";
import { api } from "#src/api/app-session.ts";
import { randomUuid } from "#src/api/uuid.ts";
import { AppText } from "#src/components/AppText.tsx";
import { BackButton } from "#src/components/BackButton.tsx";
import { PermissionCard, useCameraActive } from "#src/components/Camera.tsx";
import { cameraPlan, type CameraPlan } from "#src/components/camera-plan.ts";
import { Button } from "#src/components/Controls.tsx";
import { RehearsalStrip } from "#src/components/RehearsalStrip.tsx";
import { isolatedName } from "#src/event/full-name.ts";
import { isRehearsalStatus } from "#src/event/rehearsal.ts";
import { Screen } from "#src/components/Screen.tsx";
import { useI18n } from "#src/i18n/provider.tsx";
import { scanFor } from "#src/operator/operator-api.ts";
import { useOperator } from "#src/operator/OperatorContext.tsx";
import { admit, outcomeOf, settlesKey } from "#src/operator/station-flow.ts";
import {
  answered,
  attemptFor,
  type ScanMemory,
  type ScannedPlayer,
  type StationResult,
} from "#src/operator/station.ts";
import { useThemedStyles } from "#src/theme/theme.tsx";

/** FR-924: the result covers the screen this long, then the scanner is ready again (within one second). */
const RESULT_MS = 900;

/** Haptics never block a scan: a phone without them simply stays still. */
const buzz = (run: () => Promise<void>) => void run().catch(() => undefined);

const FEEL = {
  green: Haptics.NotificationFeedbackType.Success,
  orange: Haptics.NotificationFeedbackType.Warning,
  red: Haptics.NotificationFeedbackType.Error,
} as const;

/** What the cover shows: the result, and whether the server said it was a practice scan (never the phone's switch). */
type Shown = Readonly<{ result: StationResult; practice: boolean }>;

/** Who was scanned: the full name when the event shows it to its staff (FR-1842), then the username. */
function ScannedLines({
  player,
  textStyle,
}: Readonly<{ player: ScannedPlayer | null; textStyle: StyleProp<TextStyle> }>) {
  if (player === null) {
    return null;
  }
  return (
    <>
      {player.fullName === null ? null : (
        <AppText variant="title" style={textStyle}>
          {isolatedName(player.fullName)}
        </AppText>
      )}
      <AppText variant="title" style={textStyle}>
        {player.username}
      </AppText>
    </>
  );
}

/**
 * The full-screen result (FR-924): green with the points, orange for "already completed", red with the reason; a
 * practice scan adds "Practice · not saved" under it (FR-929).
 */
function ResultCover({ shown }: Readonly<{ shown: Shown }>) {
  const { result } = shown;
  const { t, language } = useI18n();
  const styles = useThemedStyles(makeStyles);
  const words =
    result.color === "green"
      ? t("operator.green", { points: formatNumber(result.points, language) })
      : result.color === "orange"
        ? t("operator.orange")
        : t(result.reason);
  return (
    <View style={[styles.cover, styles[result.color]]} accessibilityLiveRegion="assertive">
      <AppText variant="display" style={styles.coverText} accessibilityRole="alert">
        {words}
      </AppText>
      <ScannedLines player={result.player} textStyle={styles.coverText} />
      {shown.practice && result.color === "green" && result.bonusPoints !== null ? (
        <AppText variant="title" style={styles.coverText}>
          {t("operator.practice.firstBonus", {
            points: formatNumber(result.bonusPoints, language),
          })}
        </AppText>
      ) : null}
      {shown.practice ? (
        <AppText variant="label" style={styles.coverText}>
          {t("operator.practice.result")}
        </AppText>
      ) : null}
    </View>
  );
}

/** What the station's handlers read and write: the values and refs of the screen they act for. */
type Run = Readonly<{
  t: ReturnType<typeof useI18n>["t"];
  station: ReturnType<typeof useOperator>["station"];
  practice: boolean;
  removed: () => void;
  memory: { current: ScanMemory };
  busy: { current: boolean };
  timer: { current: ReturnType<typeof setTimeout> | null };
  setResult: (shown: Shown | null) => void;
  setProblem: (problem: string | null) => void;
}>;

/** Covers the screen with a result, buzzes for its colour, and frees the scanner again after `RESULT_MS`. */
function showResult(run: Run, next: Shown) {
  run.setResult(next);
  buzz(() => Haptics.notificationAsync(FEEL[next.result.color]));
  run.timer.current = setTimeout(() => {
    run.setResult(null);
    run.busy.current = false;
  }, RESULT_MS);
}

/** What follows an answer that decided nothing or ended the session. */
function afterRefused(run: Run, kind: string) {
  const outcome = outcomeOf(kind);
  if (outcome === "removed") {
    run.removed();
  } else if (outcome === "signed_out") {
    router.replace("/home");
  } else {
    // Nothing was decided: the same code may be scanned again at once.
    run.memory.current = { ...run.memory.current, last: null };
    run.setProblem(run.t("join.network"));
  }
}

/** One camera read at the station: admitted by the memory, sent with its key, and its answer taken in. */
async function scanStation(run: Run, data: string) {
  const code = data.trim();
  const now = Date.now();
  const { station } = run;
  if (station === null) {
    return;
  }
  const entry = admit(run.memory.current, run.practice, {
    code,
    questId: station.questId,
    now,
    busy: run.busy.current,
  });
  run.memory.current = entry.memory;
  if (entry.action === "repeat" || entry.action === "busy") {
    return;
  }
  run.busy.current = true;
  if (entry.action === "invalid") {
    showResult(run, {
      result: { color: "red", reason: "operator.red.invalidCode", player: null },
      practice: false,
    });
    return;
  }
  run.setProblem(null);
  const sent = attemptFor(run.memory.current, { code, questId: station.questId }, randomUuid);
  run.memory.current = sent.memory;
  const answer = await scanFor(run.practice)(api.session, {
    questId: station.questId,
    code,
    idempotencyKey: sent.key,
  });
  if (settlesKey(answer.kind)) {
    run.memory.current = answered(run.memory.current);
  }
  if (answer.kind === "result") {
    showResult(run, { result: answer.result, practice: answer.practice });
    return;
  }
  run.busy.current = false;
  afterRefused(run, answer.kind);
}

/** Shown when the screen was opened without a picked station. */
function NoStation() {
  const { t } = useI18n();
  return (
    <>
      <AppText accessibilityRole="alert">{t("operator.noStation")}</AppText>
      <Button label={t("operator.home")} onPress={() => router.back()} />
    </>
  );
}

/** The camera area: the permission wait, its card, the live camera with the practice note, and the failure note. */
function StationCamera({
  plan,
  practice,
  cameraFailed,
  onAllow,
  onScanned,
  onMountError,
}: Readonly<{
  plan: CameraPlan;
  practice: boolean;
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
        <>
          <View style={styles.camera}>
            <CameraView
              style={{ flex: 1 }}
              facing="back"
              barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
              onBarcodeScanned={onScanned}
              onMountError={onMountError}
            />
          </View>
          {practice ? (
            <AppText variant="label" style={styles.footer}>
              {t("operator.practice.footer")}
            </AppText>
          ) : null}
        </>
      ) : null}
      {cameraFailed ? (
        <AppText accessibilityRole="alert">{t("scanner.cameraFailed")}</AppText>
      ) : null}
    </>
  );
}

/**
 * Station mode (FR-923): the operator picked a quest on Home; each player's My QR scanned here completes it for that
 * player, one after another, with no prompt. The same code held up is one scan (5 seconds here, 10 at the server).
 * A removed operator leaves operator mode at the first refused scan (FR-905).
 */
export default function StationScanScreen() {
  const { t } = useI18n();
  const { event, station, removed, practice } = useOperator();
  const [permission, requestPermission, getPermission] = useCameraPermissions();
  const active = useCameraActive();
  const [result, setResult] = useState<Shown | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [cameraFailed, setCameraFailed] = useState(false);
  const busy = useRef(false);
  // The last code (held up, it stays one scan) and its key; forgotten when practice mode changes (memoryIn).
  const memory = useRef<ScanMemory>({ practice, last: null, attempt: null });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) {
        clearTimeout(timer.current);
      }
    },
    [],
  );

  useEffect(() => {
    const watcher = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        void getPermission();
      }
    });
    return () => watcher.remove();
  }, [getPermission]);

  const run: Run = { t, station, practice, removed, memory, busy, timer, setResult, setProblem };
  const plan = cameraPlan(permission, station !== null, active && !cameraFailed);
  return (
    <Screen
      title={station?.title ?? t("operator.station")}
      header={
        <>
          <BackButton />
          <RehearsalStrip shown={isRehearsalStatus(event?.statusNow)} />
        </>
      }
    >
      {station === null ? <NoStation /> : null}
      <StationCamera
        plan={plan}
        practice={practice}
        cameraFailed={cameraFailed}
        onAllow={() => void requestPermission()}
        onScanned={(read) => void scanStation(run, read.data)}
        onMountError={() => setCameraFailed(true)}
      />
      {problem === null ? null : <AppText accessibilityRole="alert">{problem}</AppText>}
      {result === null ? null : <ResultCover shown={result} />}
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
  cover: {
    position: "absolute" as const,
    top: 0,
    bottom: 0,
    start: 0,
    end: 0,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    gap: theme.spacing.md,
    padding: theme.spacing.lg,
  },
  // Station colours are a signal, readable at arm's length in daylight: white text on each.
  green: { backgroundColor: "#1E7F3C" },
  orange: { backgroundColor: "#C25E00" },
  red: { backgroundColor: "#B3261E" },
  coverText: { color: "#FFFFFF", textAlign: "center" as const },
  footer: { textAlign: "center" as const },
});
