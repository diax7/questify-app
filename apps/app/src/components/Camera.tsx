import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { AppState, Linking, View } from "react-native";
import { AppText } from "#src/components/AppText.tsx";
import { Button } from "#src/components/Controls.tsx";
import { useI18n } from "#src/i18n/provider.tsx";

/** True while this screen is in front and the app is in the foreground: the camera runs only then. */
export function useCameraActive(): boolean {
  const [focused, setFocused] = useState(false);
  const [foreground, setForeground] = useState(AppState.currentState === "active");
  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      return () => setFocused(false);
    }, []),
  );
  useEffect(() => {
    const watcher = AppState.addEventListener("change", (state) =>
      setForeground(state === "active"),
    );
    return () => watcher.remove();
  }, []);
  return focused && foreground;
}

/** Coming back from Settings re-reads the permission, so allowing it there works without a restart. */
export function useRecheckOnReturn(recheck: () => unknown): void {
  useEffect(() => {
    const watcher = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        void recheck();
      }
    });
    return () => watcher.remove();
  }, [recheck]);
}

/** Asked when the scanner opens, never at launch; denied once on Android may be asked again (STORE_COMPLIANCE §2.7). */
export function PermissionCard({
  canAskAgain,
  onAllow,
}: Readonly<{ canAskAgain: boolean; onAllow: () => void }>) {
  const { t } = useI18n();
  return (
    <View style={{ gap: 12 }}>
      <AppText variant="title">{t("scanner.permissionTitle")}</AppText>
      <AppText>{canAskAgain ? t("scanner.permissionBody") : t("scanner.denied")}</AppText>
      {canAskAgain ? (
        <Button label={t("scanner.allow")} onPress={onAllow} />
      ) : (
        <Button
          label={t("scanner.openSettings")}
          onPress={() => void Linking.openSettings().catch(() => undefined)}
        />
      )}
    </View>
  );
}
