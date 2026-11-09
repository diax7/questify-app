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

type ToolLinksProps = Readonly<{ eventId: string; abilities: readonly string[] }>;

function RotatingQrLinks({ eventId }: Readonly<{ eventId: string }>) {
  const { t } = useI18n();
  return (
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
  );
}

function ScanTools({ eventId }: Readonly<{ eventId: string }>) {
  const { t } = useI18n();
  const { practice, setPractice } = useOperator();
  return (
    <>
      <Button
        label={t("door.title")}
        onPress={() => router.push(`/operator/${eventId}/session-door`)}
      />
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
  );
}

function OperatorToolLinks({ eventId, abilities }: ToolLinksProps) {
  const { t } = useI18n();
  return (
    <>
      {abilities.includes("award") ? (
        <Button
          label={t("operator.award.title")}
          onPress={() => router.push(`/operator/${eventId}/award`)}
        />
      ) : null}
      {abilities.includes("review") ? (
        <Button
          label={t("operators.ability.review")}
          onPress={() => router.push(`/operator/${eventId}/review`)}
        />
      ) : null}
      {abilities.includes("write_nfc") ? (
        <Button
          label={t("operator.nfc.write")}
          onPress={() => router.push(`/operator/${eventId}/nfc-write`)}
        />
      ) : null}
      {abilities.includes("show_rotating_qr") ? <RotatingQrLinks eventId={eventId} /> : null}
      {abilities.includes("scan_quests") ? <ScanTools eventId={eventId} /> : null}
    </>
  );
}

/**
 * Operator Tools (FR-922): Manual award first, shown only with the `award` ability (OPERATOR_MODE 3.5); Review
 * submissions with the `review` ability (T-301); Write NFC tag with the `write_nfc` ability (T-308); Rotating QR, Pair a
 * device and My paired devices with the `show_rotating_qr` ability (T-309); Practice mode with the `scan_quests` ability
 * (T-311, FR-929: held in memory, off when staff mode ends); the switch to Player mode, shown only to an operator the
 * owner allows to play (FR-906, FR-907).
 */
export default function OperatorToolsScreen() {
  const { t, language } = useI18n();
  const { eventId, event } = useOperator();
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
        <OperatorToolLinks eventId={eventId} abilities={event?.abilities ?? []} />
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
