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

type ScanNotice = "joinScan.eventOnly" | "joinScan.notJoin";

/** Coming back from Settings re-reads the camera permission, so allowing it there works without a restart. */
function useRefreshedPermission(refresh: () => Promise<unknown>) {
  useEffect(() => {
    const watcher = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        void refresh();
      }
    });
    return () => watcher.remove();
  }, [refresh]);
}

/** What each read does: opens an invite or a join card, or sets the one notice for a code that cannot open here. */
function useJoinScanner() {
  const [notice, setNotice] = useState<ScanNotice | null>(null);
  const gate = useRef<ScanGate>(OPEN_GATE);
  const scanned = ({ data }: { data: string }) => {
    if (!passes(gate.current, data)) {
      return;
    }
    const scan = classifyJoinScan(data, EXTRA_ORIGIN);
    if (scan.kind === "invite" || scan.kind === "join") {
      gate.current = { busy: true, ignored: null };
      router.replace(
        scan.kind === "invite"
          ? `/operator-invite/${scan.token}`
          : { pathname: "/join/[code]", params: { code: scan.code, via: "qr" } },
      );
      return;
    }
    gate.current = { busy: false, ignored: data };
    setNotice(scan.kind === "event_only" ? "joinScan.eventOnly" : "joinScan.notJoin");
    buzz(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning));
  };
  return { notice, scanned };
}

function ScanCamera({ onScanned }: Readonly<{ onScanned: (read: { data: string }) => void }>) {
  const { t } = useI18n();
  const styles = useThemedStyles(makeStyles);
  const [cameraFailed, setCameraFailed] = useState(false);
  if (cameraFailed) {
    return <AppText accessibilityRole="alert">{t("scanner.cameraFailed")}</AppText>;
  }
  return (
    <View style={styles.camera}>
      <CameraView
        style={{ flex: 1 }}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
        onBarcodeScanned={onScanned}
        onMountError={() => setCameraFailed(true)}
      />
    </View>
  );
}

/**
 * The center button outside an event (FR-831, FR-1614, ADR-324): the live camera only, reading event join codes and
 * operator invites. A code that belongs inside an event says to open the event first; the same unrecognised code is
 * reported once.
 */
export function JoinScanScreen() {
  const { t } = useI18n();
  const [permission, requestPermission, getPermission] = useCameraPermissions();
  const active = useCameraActive();
  const { notice, scanned } = useJoinScanner();
  useRefreshedPermission(getPermission);
  const granted = permission?.granted === true;
  return (
    <Screen title={t("joinScan.title")} header={<BackButton />}>
      {permission === null ? <AppText muted>{t("common.loading")}</AppText> : null}
      {permission !== null && !granted ? (
        <PermissionCard
          canAskAgain={permission.canAskAgain}
          onAllow={() => void requestPermission()}
        />
      ) : null}
      {granted && active ? <ScanCamera onScanned={scanned} /> : null}
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
