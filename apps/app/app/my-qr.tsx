import * as SecureStore from "expo-secure-store";
import { useCallback, useEffect, useState } from "react";
import { ScrollView, useWindowDimensions, View } from "react-native";
import { api } from "#src/api/app-session.ts";
import { MY_QR_KEY } from "#src/api/session.ts";
import { randomUuid } from "#src/api/uuid.ts";
import { AppText } from "#src/components/AppText.tsx";
import { BackButton } from "#src/components/BackButton.tsx";
import { Button } from "#src/components/Controls.tsx";
import { QrCode } from "#src/components/QrCode.tsx";
import { Screen } from "#src/components/Screen.tsx";
import { usePlayer } from "#src/auth/player.tsx";
import { useI18n } from "#src/i18n/provider.tsx";
import { fetchMyQr, resetMyQr } from "#src/operator/operator-api.ts";
import { playerOfCode } from "#src/operator/station.ts";

const store = {
  read: () => SecureStore.getItemAsync(MY_QR_KEY).catch(() => null),
  write: (token: string) =>
    SecureStore.setItemAsync(MY_QR_KEY, token, {
      keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
    }).catch(() => undefined),
};

/**
 * My QR (FR-306, ADR-137): the player's fixed code, which an operator scans at a station. Showing it only says who the
 * player is; prizes need the player's own confirmation (T-206). A code someone else saw can be changed at once.
 */
export default function MyQrScreen() {
  const { t, language } = useI18n();
  const { state } = usePlayer();
  const me = state.status === "signed_in" ? state.me?.id : undefined;
  const { width } = useWindowDimensions();
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    // Another account's code never shows, even if dropping it at sign-out failed.
    const stored = await store.read();
    const cached =
      stored !== null && (me === undefined || playerOfCode(stored) === me) ? stored : null;
    if (cached !== null) {
      setToken(cached);
    }
    const answer = await fetchMyQr(api.session);
    if (answer.kind === "code") {
      setToken(answer.token);
      await store.write(answer.token);
    } else if (cached === null) {
      setToken(null);
    }
  }, [me]);
  useEffect(() => {
    void load();
  }, [load]);

  const reset = async () => {
    setBusy(true);
    const answer = await resetMyQr(api.session, randomUuid());
    setBusy(false);
    setConfirming(false);
    if (answer.kind === "code") {
      setToken(answer.token);
      await store.write(answer.token);
      setNote(t("myQr.resetDone"));
    } else if (answer.kind === "refused") {
      setNote(answer.message === null ? t("join.network") : answer.message[language]);
    } else {
      setNote(t("join.network"));
    }
  };

  return (
    <Screen title={t("myQr.title")} header={<BackButton />}>
      <ScrollView contentContainerStyle={{ gap: 16, alignItems: "center" }}>
        {token === undefined ? <AppText muted>{t("common.loading")}</AppText> : null}
        {token === null ? <AppText accessibilityRole="alert">{t("myQr.offline")}</AppText> : null}
        {typeof token === "string" ? (
          <View style={{ padding: 12, backgroundColor: "#ffffff", borderRadius: 12 }}>
            <QrCode text={token} size={Math.min(width - 72, 320)} label={t("myQr.title")} />
          </View>
        ) : null}
        <AppText>{t("myQr.hint")}</AppText>
        {note === null ? null : <AppText accessibilityRole="alert">{note}</AppText>}
        {confirming ? (
          <View style={{ gap: 8, alignSelf: "stretch" }}>
            <AppText variant="title">{t("myQr.resetTitle")}</AppText>
            <AppText>{t("myQr.resetBody")}</AppText>
            <Button label={t("myQr.reset")} disabled={busy} onPress={() => void reset()} />
            <Button kind="quiet" label={t("common.cancel")} onPress={() => setConfirming(false)} />
          </View>
        ) : (
          <Button kind="quiet" label={t("myQr.reset")} onPress={() => setConfirming(true)} />
        )}
      </ScrollView>
    </Screen>
  );
}
