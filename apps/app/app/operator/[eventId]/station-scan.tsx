import { formatNumber, type Theme } from "@questify/shared";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { AppState, View } from "react-native";
import { api } from "#src/api/app-session.ts";
import { randomUuid } from "#src/api/uuid.ts";
import { AppText } from "#src/components/AppText.tsx";
import { BackButton } from "#src/components/BackButton.tsx";
import { PermissionCard, useCameraActive } from "#src/components/Camera.tsx";
import { Button } from "#src/components/Controls.tsx";
import { RehearsalStrip } from "#src/components/RehearsalStrip.tsx";
import { isRehearsalStatus } from "#src/event/rehearsal.ts";
import { Screen } from "#src/components/Screen.tsx";
import { useI18n } from "#src/i18n/provider.tsx";
import { scanPlayer } from "#src/operator/operator-api.ts";
import { useOperator } from "#src/operator/OperatorContext.tsx";
import {
  held,
  isPlayerCode,
  isRepeat,
  type LastScan,
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

/** The full-screen result (FR-924): green with the points, orange for "already completed", red with the reason. */
function ResultCover({ result }: Readonly<{ result: StationResult }>) {
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
      {result.player === null ? null : (
        <AppText variant="title" style={styles.coverText}>
          {result.player.username}
        </AppText>
      )}
    </View>
  );
}

/**
 * Station mode (FR-923): the operator picked a quest on Home; each player's My QR scanned here completes it for that
 * player, one after another, with no prompt. The same code held up is one scan (5 seconds here, 10 at the server).
 * A removed operator leaves operator mode at the first refused scan (FR-905).
 */
export default function StationScanScreen() {
  const { t } = useI18n();
  const styles = useThemedStyles(makeStyles);
  const { event, station, removed } = useOperator();
  const [permission, requestPermission, getPermission] = useCameraPermissions();
  const active = useCameraActive();
  const [result, setResult] = useState<StationResult | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [cameraFailed, setCameraFailed] = useState(false);
  const busy = useRef(false);
  const last = useRef<LastScan>(null);
  // One key per code and station until the server gives a definite answer: a retry after a lost reply never pays twice.
  const attempt = useRef<Readonly<{ code: string; questId: string; key: string }> | null>(null);
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

  const show = (next: StationResult) => {
    setResult(next);
    buzz(() => Haptics.notificationAsync(FEEL[next.color]));
    timer.current = setTimeout(() => {
      setResult(null);
      busy.current = false;
    }, RESULT_MS);
  };

  const scanned = async ({ data }: { data: string }) => {
    const code = data.trim();
    const now = Date.now();
    if (station === null) {
      return;
    }
    // A code still in front of the camera keeps its one scan for as long as it stays (the window slides).
    if (last.current !== null && isRepeat(last.current, code, station.questId, now)) {
      last.current = held(last.current, now);
      return;
    }
    if (busy.current) {
      return;
    }
    busy.current = true;
    last.current = { code, questId: station.questId, at: now };
    if (!isPlayerCode(code)) {
      show({ color: "red", reason: "operator.red.invalidCode", player: null });
      return;
    }
    setProblem(null);
    const same = attempt.current?.code === code && attempt.current.questId === station.questId;
    const key = same && attempt.current !== null ? attempt.current.key : randomUuid();
    attempt.current = { code, questId: station.questId, key };
    const answer = await scanPlayer(api.session, {
      questId: station.questId,
      code,
      idempotencyKey: key,
    });
    if (answer.kind !== "network") {
      attempt.current = null;
    }
    if (answer.kind === "result") {
      show(answer.result);
      return;
    }
    busy.current = false;
    if (answer.kind === "removed") {
      removed();
    } else if (answer.kind === "signed_out") {
      router.replace("/home");
    } else {
      // Nothing was decided: the same code may be scanned again at once.
      last.current = null;
      setProblem(t("join.network"));
    }
  };

  const granted = permission?.granted === true;
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
      {station === null ? (
        <>
          <AppText accessibilityRole="alert">{t("operator.noStation")}</AppText>
          <Button label={t("operator.home")} onPress={() => router.back()} />
        </>
      ) : null}
      {station !== null && permission === null ? (
        <AppText muted>{t("common.loading")}</AppText>
      ) : null}
      {station !== null && permission !== null && !granted ? (
        <PermissionCard
          canAskAgain={permission.canAskAgain}
          onAllow={() => void requestPermission()}
        />
      ) : null}
      {station !== null && granted && active && !cameraFailed ? (
        <>
          <AppText muted>{t("operator.scanHint")}</AppText>
          <View style={styles.camera}>
            <CameraView
              style={{ flex: 1 }}
              facing="back"
              barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
              onBarcodeScanned={(read) => void scanned(read)}
              onMountError={() => setCameraFailed(true)}
            />
          </View>
        </>
      ) : null}
      {cameraFailed ? (
        <AppText accessibilityRole="alert">{t("scanner.cameraFailed")}</AppText>
      ) : null}
      {problem === null ? null : <AppText accessibilityRole="alert">{problem}</AppText>}
      {result === null ? null : <ResultCover result={result} />}
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
});
