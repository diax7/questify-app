import { joinCard, type MessageKey } from "@questify/shared";
import { router } from "expo-router";
import { useState } from "react";
import { View } from "react-native";
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

/** The Tools entries that come with later tasks (FR-922): rotating QR, NFC. */
const LATER: readonly MessageKey[] = [
  "operators.ability.showRotatingQr",
  "operators.ability.writeNfc",
];

/**
 * Operator Tools (FR-922): Manual award first, shown only with the `award` ability (OPERATOR_MODE 3.5); the switch to
 * Player mode, shown only to an operator the owner allows to play (FR-906, FR-907); the other tools are listed as coming.
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
        {event?.abilities.includes("award") === true ? (
          <Button
            label={t("operator.award.title")}
            onPress={() => router.push(`/operator/${eventId}/award`)}
          />
        ) : null}
        {event?.canPlay === true ? (
          <Button
            label={t("operator.switchToPlayer")}
            disabled={busy}
            onPress={() => void switchToPlayer()}
          />
        ) : null}
        {problem === null ? null : <AppText accessibilityRole="alert">{problem}</AppText>}
        {LATER.map((key) => (
          <AppText key={key} muted>
            {`${t(key)} · ${t("common.comingSoon")}`}
          </AppText>
        ))}
      </View>
    </Screen>
  );
}
