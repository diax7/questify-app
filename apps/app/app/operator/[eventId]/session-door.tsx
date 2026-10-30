import { formatTimeWindow, type Theme } from "@questify/shared";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { AppState, View } from "react-native";
import { api } from "#src/api/app-session.ts";
import { AppText } from "#src/components/AppText.tsx";
import { BackButton } from "#src/components/BackButton.tsx";
import { PermissionCard, useCameraActive } from "#src/components/Camera.tsx";
import { Button } from "#src/components/Controls.tsx";
import { Screen } from "#src/components/Screen.tsx";
import { useI18n } from "#src/i18n/provider.tsx";
import { textIn } from "#src/i18n/text.ts";
import { useOperator } from "#src/operator/OperatorContext.tsx";
import {
  checkInPlayer,
  fetchDoorSessions,
  type DoorCheckIn,
  type DoorResult,
  type DoorSession,
} from "#src/operator/session-door.ts";
import { isPlayerCode } from "#src/operator/station.ts";
import { useThemedStyles } from "#src/theme/theme.tsx";

/** The result covers the screen this long, then the scanner is ready again (FR-924's pace). */
const RESULT_MS = 900;
/** The same code held up is one scan for this long. */
const REPEAT_MS = 5000;

const FEEL = {
  green: Haptics.NotificationFeedbackType.Success,
  orange: Haptics.NotificationFeedbackType.Warning,
  red: Haptics.NotificationFeedbackType.Error,
} as const;

type Last = Readonly<{ code: string; at: number }>;

/** The same code still in front of the camera is one scan. */
const heldUp = (last: Last | null, code: string, now: number): boolean =>
  last !== null && last.code === code && now - last.at < REPEAT_MS;

/** Haptics never block a scan: a phone without them simply stays still. */
const buzz = (run: () => Promise<void>) => void run().catch(() => undefined);

function useDoorSessions(eventId: string, removed: () => void) {
  const [sessions, setSessions] = useState<readonly DoorSession[]>();
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const onRemoved = useRef(removed);
  onRemoved.current = removed;
  useEffect(() => {
    let active = true;
    void fetchDoorSessions(api.session, eventId).then((read) => {
      if (!active) return;
      if (read.kind === "removed") onRemoved.current();
      else if (read.kind === "signed_out") router.replace("/home");
      else if (read.kind === "sessions") setSessions(read.sessions);
      setFailed(read.kind === "network");
    });
    return () => {
      active = false;
    };
  }, [eventId, attempt]);
  return { sessions, failed, reload: () => setAttempt((value) => value + 1) };
}

function SessionPicker({
  eventId,
  zone,
  choose,
  removed,
}: Readonly<{
  eventId: string;
  zone: string;
  choose: (session: DoorSession) => void;
  removed: () => void;
}>) {
  const { t, language } = useI18n();
  const door = useDoorSessions(eventId, removed);
  if (door.failed) {
    return (
      <>
        <AppText accessibilityRole="alert">{t("join.network")}</AppText>
        <Button label={t("common.retry")} onPress={door.reload} />
      </>
    );
  }
  if (door.sessions === undefined) return <AppText muted>{t("common.loading")}</AppText>;
  if (door.sessions.length === 0) return <AppText>{t("door.none")}</AppText>;
  return (
    <>
      <AppText variant="label">{t("door.pick")}</AppText>
      {door.sessions.map((session) => (
        <Button
          key={session.id}
          kind="quiet"
          label={`${textIn(session.title, language)} · ${formatTimeWindow(
            new Date(session.startsAt),
            new Date(session.endsAt),
            zone,
            language,
          )}`}
          onPress={() => choose(session)}
        />
      ))}
    </>
  );
}

function ResultCover({ result }: Readonly<{ result: DoorResult }>) {
  const { t } = useI18n();
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={[styles.cover, styles[result.color]]} accessibilityLiveRegion="assertive">
      <AppText variant="display" style={styles.coverText} accessibilityRole="alert">
        {t(result.message)}
      </AppText>
      {result.username === null ? null : (
        <AppText variant="title" style={styles.coverText}>
          {result.username}
        </AppText>
      )}
    </View>
  );
}

function DoorScanner({
  session,
  removed,
}: Readonly<{ session: DoorSession; removed: () => void }>) {
  const { t } = useI18n();
  const styles = useThemedStyles(makeStyles);
  const [permission, requestPermission, getPermission] = useCameraPermissions();
  const active = useCameraActive();
  const [result, setResult] = useState<DoorResult | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [cameraFailed, setCameraFailed] = useState(false);
  const busy = useRef(false);
  const last = useRef<Last | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );
  useEffect(() => {
    const watcher = AppState.addEventListener("change", (state) => {
      if (state === "active") void getPermission();
    });
    return () => watcher.remove();
  }, [getPermission]);

  const show = (next: DoorResult) => {
    setResult(next);
    buzz(() => Haptics.notificationAsync(FEEL[next.color]));
    timer.current = setTimeout(() => {
      setResult(null);
      busy.current = false;
    }, RESULT_MS);
  };
  const settle = (answer: Exclude<DoorCheckIn, { kind: "result" }>) => {
    busy.current = false;
    last.current = null;
    if (answer.kind === "removed") removed();
    else if (answer.kind === "signed_out") router.replace("/home");
    else setProblem(t("join.network"));
  };
  const scanned = async ({ data }: { data: string }) => {
    const code = data.trim();
    const now = Date.now();
    if (busy.current || heldUp(last.current, code, now)) return;
    busy.current = true;
    last.current = { code, at: now };
    setProblem(null);
    if (!isPlayerCode(code)) {
      show({ color: "red", message: "door.invalid", username: null });
      return;
    }
    const answer = await checkInPlayer(api.session, session.id, code);
    if (answer.kind === "result") show(answer.result);
    else settle(answer);
  };

  if (permission === null) return <AppText muted>{t("common.loading")}</AppText>;
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
      {active && !cameraFailed ? (
        <View style={styles.camera}>
          <CameraView
            style={{ flex: 1 }}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
            onBarcodeScanned={(read) => void scanned(read)}
            onMountError={() => setCameraFailed(true)}
          />
        </View>
      ) : null}
      {cameraFailed ? (
        <AppText accessibilityRole="alert">{t("scanner.cameraFailed")}</AppText>
      ) : null}
      {problem === null ? null : <AppText accessibilityRole="alert">{problem}</AppText>}
      {result === null ? null : <ResultCover result={result} />}
    </>
  );
}

/**
 * The door check-in (FR-1791, T-505): the operator picks the session at the door, then scans each player's My QR. The
 * answer covers the screen in a colour: green checked in (or a walk-in), orange already checked in, red with the reason.
 * A removed operator leaves operator mode at the first refused call (FR-905).
 */
export default function SessionDoorScreen() {
  const { t, language } = useI18n();
  const { eventId, event, removed } = useOperator();
  const [chosen, setChosen] = useState<DoorSession | null>(null);
  const zone = event?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  return (
    <Screen
      title={chosen === null ? t("door.title") : textIn(chosen.title, language)}
      header={<BackButton />}
    >
      {chosen === null ? (
        <SessionPicker eventId={eventId} zone={zone} choose={setChosen} removed={removed} />
      ) : (
        <>
          <Button kind="quiet" label={t("door.pick")} onPress={() => setChosen(null)} />
          <DoorScanner session={chosen} removed={removed} />
        </>
      )}
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
  // Door colours are a signal, readable at arm's length in daylight: white text on each.
  green: { backgroundColor: "#1E7F3C" },
  orange: { backgroundColor: "#C25E00" },
  red: { backgroundColor: "#B3261E" },
  coverText: { color: "#FFFFFF", textAlign: "center" as const },
});
