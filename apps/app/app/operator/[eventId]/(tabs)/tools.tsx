import { joinCard } from "@questify/shared";
import { router } from "expo-router";
import { useState } from "react";
import { Switch, View } from "react-native";
import { api } from "#src/api/app-session.ts";
import { randomUuid } from "#src/api/uuid.ts";
import { AppText } from "#src/components/AppText.tsx";
import { Button } from "#src/components/Controls.tsx";
import { RehearsalStrip } from "#src/components/RehearsalStrip.tsx";
import { isRehearsalStatus } from "#src/event/rehearsal.ts";
import { Screen } from "#src/components/Screen.tsx";
import { useI18n } from "#src/i18n/provider.tsx";
import { playAsPlayer } from "#src/operator/operator-api.ts";
import { useOperator } from "#src/operator/OperatorContext.tsx";

/**
 * Operator Tools (FR-922): Manual award first, shown only with the `award` ability (OPERATOR_MODE 3.5); Review
 * submissions with the `review` ability (T-301); Write NFC tag with the `write_nfc` ability (T-308); Rotating QR, Pair a
 * device and My paired devices with the `show_rotating_qr` ability (T-309); Practice mode with the `scan_quests` ability
 * (T-311, FR-929: held in memory, off when staff mode ends); the switch to Player mode, shown only to an operator the
 * owner allows to play (FR-906, FR-907).
 */
export default function OperatorToolsScreen() {
  const { t, language } = useI18n();
  const { eventId, event, practice, setPractice } = useOperator();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const switchToPlayer = async () => {
    setBusy(true);
    setProblem(null);
    const answer = await playAsPlayer(api.session, eventId, joinCard().version, randomUuid());
    setBusy(false);
    if (answer.kind === "joined") {
      router.replace(`/event/${eventId}`);
    } else if (answer.kind === "refused" && answer.message !== null) {
      setProblem(answer.message[language]);
    } else {
      setProblem(t("join.network"));
    }
  };

  return (
    <Screen
      title={t("operator.tools")}
      header={<RehearsalStrip shown={isRehearsalStatus(event?.statusNow)} />}
    >
      <View style={{ gap: 12 }}>
        {event?.abilities.includes("award") === true ? (
          <Button
            label={t("operator.award.title")}
            onPress={() => router.push(`/operator/${eventId}/award`)}
          />
        ) : null}
        {event?.abilities.includes("review") === true ? (
          <Button
            label={t("operators.ability.review")}
            onPress={() => router.push(`/operator/${eventId}/review`)}
          />
        ) : null}
        {event?.abilities.includes("write_nfc") === true ? (
          <Button
            label={t("operator.nfc.write")}
            onPress={() => router.push(`/operator/${eventId}/nfc-write`)}
          />
        ) : null}
        {event?.abilities.includes("show_rotating_qr") === true ? (
          <>
            <Button
              label={t("operator.rotating")}
              onPress={() => router.push(`/operator/${eventId}/rotating-qr`)}
            />
            <Button
              label={t("operator.devices.pair")}
              onPress={() => router.push(`/operator/${eventId}/pair-device`)}
            />
            <Button
              kind="quiet"
              label={t("operator.devices.mine")}
              onPress={() => router.push(`/operator/${eventId}/my-devices`)}
            />
          </>
        ) : null}
        {event?.abilities.includes("scan_quests") === true ? (
          <>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
              <Switch
                value={practice}
                onValueChange={setPractice}
                accessibilityLabel={t("operator.practice.title")}
              />
              <AppText variant="label">{t("operator.practice.title")}</AppText>
            </View>
            <AppText muted>{t("operator.practice.hint")}</AppText>
          </>
        ) : null}
        {event?.canPlay === true ? (
          <Button
            label={t("operator.switchToPlayer")}
            disabled={busy}
            onPress={() => void switchToPlayer()}
          />
        ) : null}
        {problem === null ? null : <AppText accessibilityRole="alert">{problem}</AppText>}
      </View>
    </Screen>
  );
}
