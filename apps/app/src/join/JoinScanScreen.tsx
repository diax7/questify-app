import type { Theme } from "@questify/shared";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { AppState, View } from "react-native";
import { AppText } from "#src/components/AppText.tsx";
import { BackButton } from "#src/components/BackButton.tsx";
import { PermissionCard, useCameraActive } from "#src/components/Camera.tsx";
import { Screen } from "#src/components/Screen.tsx";
import { OPEN_GATE, passes, questCodeOrigin, type ScanGate } from "#src/event/scan.ts";
import { useI18n } from "#src/i18n/provider.tsx";
import { classifyJoinScan } from "#src/join/join-scan.ts";
import { useThemedStyles } from "#src/theme/theme.tsx";

/** The one extra web origin this build reads codes from (a staging demo, or development): as the event scanner. */
const EXTRA_ORIGIN = questCodeOrigin(process.env["EXPO_PUBLIC_QUEST_CODE_ORIGIN"], __DEV__);

/** Haptics never block a scan: a phone without them simply stays still. */
const buzz = (run: () => Promise<void>) => void run().catch(() => undefined);

/**
 * The center button outside an event (FR-831, FR-1614, ADR-324): the live camera only, reading event join codes and
 * operator invites. A code that belongs inside an event says to open the event first; the same unrecognised code is
 * reported once.
 */
export function JoinScanScreen() {
  const { t } = useI18n();
  const styles = useThemedStyles(makeStyles);
  const [permission, requestPermission, getPermission] = useCameraPermissions();
  const active = useCameraActive();
  const [notice, setNotice] = useState<"joinScan.eventOnly" | "joinScan.notJoin" | null>(null);
  const [cameraFailed, setCameraFailed] = useState(false);
  const gate = useRef<ScanGate>(OPEN_GATE);

  // Coming back from Settings re-reads the permission, so allowing it there works without a restart.
  useEffect(() => {
    const watcher = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        void getPermission();
      }
    });
    return () => watcher.remove();
  }, [getPermission]);

  const scanned = ({ data }: { data: string }) => {
    if (!passes(gate.current, data)) {
      return;
    }
    const scan = classifyJoinScan(data, EXTRA_ORIGIN);
    if (scan.kind === "invite") {
      gate.current = { busy: true, ignored: null };
      router.replace(`/operator-invite/${scan.token}`);
      return;
    }
    if (scan.kind === "join") {
      gate.current = { busy: true, ignored: null };
      router.replace({ pathname: "/join/[code]", params: { code: scan.code, via: "qr" } });
      return;
    }
    gate.current = { busy: false, ignored: data };
    setNotice(scan.kind === "event_only" ? "joinScan.eventOnly" : "joinScan.notJoin");
    buzz(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning));
  };

  const granted = permission?.granted === true;
  return (
    <Screen title={t("joinScan.title")} header={<BackButton />}>
      <AppText muted>{t("joinScan.hint")}</AppText>
      {permission === null ? <AppText muted>{t("common.loading")}</AppText> : null}
      {permission !== null && !granted ? (
        <PermissionCard
          canAskAgain={permission.canAskAgain}
          onAllow={() => void requestPermission()}
        />
      ) : null}
      {granted && active && !cameraFailed ? (
        <View style={styles.camera}>
          <CameraView
            style={{ flex: 1 }}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
            onBarcodeScanned={scanned}
            onMountError={() => setCameraFailed(true)}
          />
        </View>
      ) : null}
      {cameraFailed ? (
        <AppText accessibilityRole="alert">{t("scanner.cameraFailed")}</AppText>
      ) : null}
      {notice === null ? null : <AppText accessibilityRole="alert">{t(notice)}</AppText>}
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
});
