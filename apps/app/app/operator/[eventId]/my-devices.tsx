import { formatNumber } from "@questify/shared";
import { useCallback, useEffect, useState } from "react";
import { ScrollView, View } from "react-native";
import { api } from "#src/api/app-session.ts";
import { AppText } from "#src/components/AppText.tsx";
import { BackButton } from "#src/components/BackButton.tsx";
import { Button } from "#src/components/Controls.tsx";
import { Screen } from "#src/components/Screen.tsx";
import { useI18n } from "#src/i18n/provider.tsx";
import { textIn } from "#src/i18n/text.ts";
import {
  deviceStatusKey,
  fetchDevices,
  revokeDevice,
  type MyDevice,
} from "#src/operator/devices.ts";
import { useOperator } from "#src/operator/OperatorContext.tsx";
import { PracticeLocked } from "#src/operator/Practice.tsx";

/**
 * Staff mode's My paired devices (T-309): the stations and kiosks this operator paired, each with its quest and state, and Revoke
 * for an active one (an operator revokes only what they paired). The dashboard's Devices page lists every device.
 */
function MyDevicesScreen() {
  const { t, language } = useI18n();
  const { eventId } = useOperator();
  const [devices, setDevices] = useState<readonly MyDevice[] | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const load = useCallback(async () => {
    const answer = await fetchDevices(api.session, eventId);
    setDevices(answer.kind === "page" ? answer.page.devices : null);
  }, [eventId]);
  useEffect(() => {
    void load();
  }, [load]);

  const revoke = async (device: MyDevice) => {
    setBusy(true);
    setProblem(null);
    const answer = await revokeDevice(api.session, eventId, device.id);
    setBusy(false);
    if (answer.kind === "refused" && answer.message !== null) {
      setProblem(answer.message[language]);
    } else if (answer.kind !== "revoked") {
      setProblem(t("join.network"));
    }
    await load();
  };

  return (
    <Screen title={t("operator.devices.mine")} header={<BackButton />}>
      <ScrollView contentContainerStyle={{ gap: 12 }}>
        {devices === undefined ? <AppText muted>{t("common.loading")}</AppText> : null}
        {devices === null ? <AppText accessibilityRole="alert">{t("join.network")}</AppText> : null}
        {devices?.length === 0 ? <AppText>{t("operator.devices.none")}</AppText> : null}
        {(devices ?? []).map((device) => (
          <View key={device.id} style={{ gap: 4 }}>
            <AppText variant="label">{device.label}</AppText>
            {device.quest === null ? null : <AppText>{textIn(device.quest, language)}</AppText>}
            <AppText muted>{t(deviceStatusKey(device))}</AppText>
            {device.scans === null ? null : (
              <AppText muted>
                {t("operator.devices.scans", { count: formatNumber(device.scans, language) })}
              </AppText>
            )}
            {device.status === "active" ? (
              <Button
                kind="quiet"
                label={t("devices.revoke")}
                disabled={busy}
                onPress={() => void revoke(device)}
              />
            ) : null}
          </View>
        ))}
        {problem === null ? null : <AppText accessibilityRole="alert">{problem}</AppText>}
      </ScrollView>
    </Screen>
  );
}

/** Locked while practice mode is on (ADR-250): this tool writes real records. */
export default function MyDevicesScreenRoute() {
  return (
    <PracticeLocked title="operator.devices.mine" back={true}>
      <MyDevicesScreen />
    </PracticeLocked>
  );
}
