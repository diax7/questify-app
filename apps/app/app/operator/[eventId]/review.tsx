import type { LocalizedText } from "@questify/shared";
import { useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { Image, ScrollView, View } from "react-native";
import { api } from "#src/api/app-session.ts";
import { randomUuid } from "#src/api/uuid.ts";
import { AppText } from "#src/components/AppText.tsx";
import { Avatar } from "#src/components/Avatar.tsx";
import { BackButton } from "#src/components/BackButton.tsx";
import { Button, Field, Problem } from "#src/components/Controls.tsx";
import { Screen } from "#src/components/Screen.tsx";
import { completedText } from "#src/event/amount.ts";
import { useI18n } from "#src/i18n/provider.tsx";
import { textIn } from "#src/i18n/text.ts";
import { useOperator } from "#src/operator/OperatorContext.tsx";
import {
  canReject,
  fetchReviewQueue,
  firstOf,
  sendReview,
  type ReviewAnswer,
  type ReviewItem,
} from "#src/operator/review.ts";
import { PracticeLocked } from "#src/operator/Practice.tsx";

/** What the server said when someone else had reviewed the submission first, in the operator's language. */
const goneText = (answer: Extract<ReviewAnswer, { kind: "gone" }>, language: "ar" | "en") =>
  answer.message?.[language] ?? null;

/** A submission's photo through its 5-minute URL (T-301b); a link that ran out says to refresh. */
function ReviewPhoto({ url }: Readonly<{ url: string }>) {
  const { t } = useI18n();
  const [failed, setFailed] = useState(false);
  if (failed) return <AppText muted>{t("photo.expired")}</AppText>;
  return (
    <Image
      source={{ uri: url }}
      accessibilityLabel={t("photo.alt")}
      style={{ width: "100%", aspectRatio: 4 / 3, borderRadius: 12 }}
      resizeMode="contain"
      onError={() => setFailed(true)}
    />
  );
}

/** What the player sent: the photo and its caption, or the text; erased words say so. */
function ReviewBody({ item }: Readonly<{ item: ReviewItem }>) {
  const { t } = useI18n();
  if (item.photoUrl === null) return <AppText>{item.text ?? t("submissions.erased")}</AppText>;
  return (
    <>
      <ReviewPhoto url={item.photoUrl} />
      {item.text === null ? null : <AppText>{item.text}</AppText>}
    </>
  );
}

/** The submission to review: who sent it, what it says, Approve, and the reason with Reject. */
function ReviewCard({
  item,
  terms,
  reason,
  onReason,
  busy,
  onReview,
}: Readonly<{
  item: ReviewItem;
  terms: ReturnType<typeof useOperator>["terms"];
  reason: string;
  onReason: (value: string) => void;
  busy: boolean;
  onReview: (decision: "approve" | "reject") => void;
}>) {
  const { t, language } = useI18n();
  return (
    <View style={{ gap: 8 }}>
      <AppText variant="label">{textIn(item.questTitle, language)}</AppText>
      <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
        <Avatar name={item.avatar} username={item.username ?? ""} size={32} />
        <AppText>
          {t("operator.review.from", { player: item.username ?? t("submissions.deletedPlayer") })}
        </AppText>
      </View>
      <AppText muted>{completedText(t, terms, language, item.points)}</AppText>
      {item.marked ? (
        <AppText accessibilityRole="alert">{t("operator.review.marked")}</AppText>
      ) : null}
      <ReviewBody item={item} />
      <Button
        label={t("operator.review.approve")}
        disabled={busy}
        onPress={() => onReview("approve")}
      />
      <Field
        label={t("operator.review.reason")}
        value={reason}
        onChangeText={onReason}
        maxLength={300}
      />
      <Button
        kind="quiet"
        label={t("operator.review.reject")}
        disabled={busy || !canReject(reason)}
        onPress={() => onReview("reject")}
      />
    </View>
  );
}

/**
 * The operator's review queue (FR-324, FR-325): one pending submission at a time, oldest first, approved or rejected
 * with a reason the player sees. Shown only with the `review` ability; the server checks it again. Opened from the Inbox
 * (`first`), that submission comes first.
 */
function OperatorReviewScreen() {
  const { t, language } = useI18n();
  const { eventId, terms } = useOperator();
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
      setSaid(answer.kind === "done" ? t("operator.review.done") : goneText(answer, language));
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
          <ReviewCard
            item={current}
            terms={terms}
            reason={reason}
            onReason={(value) => setReason(value.slice(0, 300))}
            busy={busy}
            onReview={(decision) => void review(decision)}
          />
        )}
      </ScrollView>
    </Screen>
  );
}

/** Locked while practice mode is on (ADR-250): this tool writes real records. */
export default function OperatorReviewScreenRoute() {
  return (
    <PracticeLocked title="operators.ability.review" back={true}>
      <OperatorReviewScreen />
    </PracticeLocked>
  );
}
