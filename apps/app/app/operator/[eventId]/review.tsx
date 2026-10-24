import { formatNumber, termFor, DEFAULT_TERMS, type LocalizedText } from "@questify/shared";
import { useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { ScrollView, View } from "react-native";
import { api } from "#src/api/app-session.ts";
import { randomUuid } from "#src/api/uuid.ts";
import { AppText } from "#src/components/AppText.tsx";
import { Avatar } from "#src/components/Avatar.tsx";
import { BackButton } from "#src/components/BackButton.tsx";
import { Button, Field, Problem } from "#src/components/Controls.tsx";
import { Screen } from "#src/components/Screen.tsx";
import { useI18n } from "#src/i18n/provider.tsx";
import { textIn } from "#src/i18n/text.ts";
import { useOperator } from "#src/operator/OperatorContext.tsx";
import {
  canReject,
  fetchReviewQueue,
  firstOf,
  sendReview,
  type ReviewItem,
} from "#src/operator/review.ts";

/**
 * The operator's review queue (FR-324, FR-325): one pending submission at a time, oldest first, approved or rejected
 * with a reason the player sees. Shown only with the `review` ability; the server checks it again. Opened from the Inbox
 * (`first`), that submission comes first.
 */
export default function OperatorReviewScreen() {
  const { t, language } = useI18n();
  const { eventId } = useOperator();
  const { first } = useLocalSearchParams<{ first?: string }>();
  const [queue, setQueue] = useState<ReviewItem[] | undefined | "failed">(undefined);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<LocalizedText | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [key, setKey] = useState(randomUuid);

  const load = useCallback(async () => {
    const loaded = await fetchReviewQueue(api.session, eventId);
    setQueue(loaded === undefined ? "failed" : firstOf(loaded, first));
  }, [eventId, first]);
  useEffect(() => {
    void load();
  }, [load]);

  const current = Array.isArray(queue) ? queue[0] : undefined;
  const review = async (decision: "approve" | "reject") => {
    if (current === undefined) {
      return;
    }
    setBusy(true);
    setProblem(null);
    const answer = await sendReview(api.session, {
      eventId,
      submissionId: current.id,
      decision,
      reason,
      key,
    });
    setBusy(false);
    if (answer.kind === "done" || answer.kind === "gone") {
      setSaid(
        answer.kind === "done" ? t("operator.review.done") : (answer.message?.[language] ?? null),
      );
      setReason("");
      setKey(randomUuid());
      await load();
      return;
    }
    // A dropped connection keeps the key: trying again cannot review twice.
    setProblem(answer.kind === "refused" ? answer.message : null);
    if (answer.kind === "network") {
      setSaid(t("join.network"));
    }
  };

  return (
    <Screen title={t("operators.ability.review")} header={<BackButton />}>
      <ScrollView contentContainerStyle={{ gap: 12 }}>
        {said === null ? null : <AppText accessibilityRole="alert">{said}</AppText>}
        <Problem problem={problem} />
        {queue === "failed" ? (
          <>
            <AppText accessibilityRole="alert">{t("operator.review.loadFailed")}</AppText>
            <Button kind="quiet" label={t("common.retry")} onPress={() => void load()} />
          </>
        ) : null}
        {Array.isArray(queue) && current === undefined ? (
          <AppText muted>{t("operator.review.empty")}</AppText>
        ) : null}
        {current === undefined ? null : (
          <View style={{ gap: 8 }}>
            <AppText variant="label">{textIn(current.questTitle, language)}</AppText>
            <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
              <Avatar name={current.avatar} username={current.username ?? ""} size={32} />
              <AppText>
                {t("operator.review.from", {
                  player: current.username ?? t("submissions.deletedPlayer"),
                })}
              </AppText>
            </View>
            <AppText muted>
              {`+${formatNumber(current.points, language)} ${termFor(DEFAULT_TERMS.currency, language)}`}
            </AppText>
            {current.marked ? (
              <AppText accessibilityRole="alert">{t("operator.review.marked")}</AppText>
            ) : null}
            <AppText>{current.text ?? t("submissions.erased")}</AppText>
            <Button
              label={t("operator.review.approve")}
              disabled={busy}
              onPress={() => void review("approve")}
            />
            <Field
              label={t("operator.review.reason")}
              value={reason}
              onChangeText={(value) => setReason(value.slice(0, 300))}
              maxLength={300}
            />
            <Button
              kind="quiet"
              label={t("operator.review.reject")}
              disabled={busy || !canReject(reason)}
              onPress={() => void review("reject")}
            />
          </View>
        )}
      </ScrollView>
    </Screen>
  );
}
