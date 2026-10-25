import { levelUpMessage } from "#src/questify/level.ts";
import {
  JOIN_LINK_HOSTS,
  SUBMISSION_TEXT_MAX,
  formatNumber,
  type LocalizedText,
} from "@questify/shared";
import { useCallback, useEffect, useState } from "react";
import { Linking } from "react-native";
import { api } from "#src/api/app-session.ts";
import { randomUuid } from "#src/api/uuid.ts";
import { AppText } from "#src/components/AppText.tsx";
import { Button, Field, Problem } from "#src/components/Controls.tsx";
import { usePlayer } from "#src/auth/player.tsx";
import { useEvent } from "#src/event/EventContext.tsx";
import type { Quest } from "#src/event/quests-api.ts";
import {
  acceptGuidelines,
  canSend,
  fetchMySubmissions,
  sendKey,
  sendSubmission,
  sentLine,
  submissionStep,
  type MySubmissions,
  type SendAnswer,
  type SubmissionStep,
} from "#src/event/submissions.ts";
import { useI18n } from "#src/i18n/provider.tsx";
import type { MessageKey } from "@questify/shared";

/** The first submission shows the guidelines and the terms, accepted once (FR-1706). */
function GuidelinesStep({ onAccepted }: Readonly<{ onAccepted: () => void }>) {
  const { t, language } = useI18n();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const open = (id: string) =>
    void Linking.openURL(`https://${JOIN_LINK_HOSTS[0]}/${language}/legal/${id}`);
  const accept = async () => {
    setBusy(true);
    const accepted = await acceptGuidelines(api.session);
    setBusy(false);
    setFailed(!accepted);
    if (accepted) {
      onAccepted();
    }
  };
  return (
    <>
      <AppText variant="label">{t("submission.guidelinesTitle")}</AppText>
      <AppText>{t("submission.guidelinesBody")}</AppText>
      <Button
        kind="quiet"
        label={t("submission.guidelines")}
        onPress={() => open("community_guidelines")}
      />
      <Button kind="quiet" label={t("signIn.terms")} onPress={() => open("terms_of_use")} />
      {failed ? <AppText accessibilityRole="alert">{t("join.network")}</AppText> : null}
      <Button label={t("signIn.accept")} disabled={busy} onPress={() => void accept()} />
    </>
  );
}

/** Where the player's latest submission for this quest stands, in words; null when there is nothing to say. */
function stepLine(
  step: SubmissionStep,
  t: ReturnType<typeof useI18n>["t"],
  language: "ar" | "en",
): string | null {
  switch (step.kind) {
    case "pending":
      return t("submission.pending", { points: formatNumber(step.points, language) });
    case "rejected":
      return step.system
        ? t("submission.left")
        : t("submission.rejected", { reason: step.reason ?? "" });
    case "removed":
      return t("submission.removed", { reason: step.reason ?? "" });
    case "write":
      return null;
  }
}

/** Whether the box shows: nothing sent yet, or a rejection the quest lets the player answer again. */
const canWrite = (step: SubmissionStep): boolean =>
  step.kind === "write" || (step.kind === "rejected" && step.again);

/** What a send answer says under the box. */
function answerLine(
  answer: SendAnswer,
  t: ReturnType<typeof useI18n>["t"],
  language: "ar" | "en",
): string | LocalizedText | null {
  switch (answer.kind) {
    case "sent": {
      const key: MessageKey = sentLine(answer);
      return answer.levelUp === null
        ? t(key)
        : `${t(key)} ${levelUpMessage(t, language, answer.levelUp)}`;
    }
    case "refused":
      return answer.message ?? t("questsTab.failed");
    case "network":
      return t("join.network");
    case "guidelines":
    case "signed_out":
      return null;
  }
}

/**
 * A text submission quest in the quest sheet (FR-206, FR-409, FR-1706, FR-1709): the guidelines the first time, then
 * a box with a counter; afterwards where the latest answer stands. Only the event team sees what is sent (FR-205).
 */
export function SubmissionEntry({ quest, onSent }: Readonly<{ quest: Quest; onSent: () => void }>) {
  const { t, language } = useI18n();
  const { eventId } = useEvent();
  const { state, reload } = usePlayer();
  const [mine, setMine] = useState<MySubmissions | undefined | "failed">(undefined);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<{ key: string; text: string } | undefined>(undefined);
  const [said, setSaid] = useState<string | LocalizedText | null>(null);
  const [guidelines, setGuidelines] = useState(false);

  const load = useCallback(async () => {
    setMine((await fetchMySubmissions(api.session, eventId)) ?? "failed");
  }, [eventId]);
  useEffect(() => {
    void load();
  }, [load]);

  const accepted = state.status === "signed_in" && state.me?.legal.guidelinesAccepted === true;
  // Asked again when the server says the version in force is not accepted yet (a newer one than this app's).
  if (!accepted || guidelines) {
    return (
      <GuidelinesStep
        onAccepted={() => {
          setGuidelines(false);
          void reload();
        }}
      />
    );
  }
  if (mine === undefined) {
    return null;
  }
  if (mine === "failed") {
    return (
      <>
        <AppText accessibilityRole="alert">{t("submission.loadFailed")}</AppText>
        <Button kind="quiet" label={t("common.retry")} onPress={() => void load()} />
      </>
    );
  }
  const step = submissionStep(quest.id, mine.submissions);
  const line = stepLine(step, t, language);
  const send = async () => {
    const key = sendKey(last, text, randomUuid);
    setBusy(true);
    const answer = await sendSubmission(api.session, quest.id, text, key);
    setBusy(false);
    setLast({ key, text });
    if (answer.kind === "guidelines") {
      setGuidelines(true);
      return;
    }
    setSaid(answerLine(answer, t, language));
    if (answer.kind === "sent") {
      setText("");
      setLast(undefined);
      onSent();
      await load();
    }
  };
  return (
    <>
      {line === null ? null : <AppText variant="label">{line}</AppText>}
      {step.kind === "rejected" && !step.again ? (
        <AppText muted>{t("submission.closed")}</AppText>
      ) : null}
      {typeof said === "string" ? <AppText accessibilityRole="alert">{said}</AppText> : null}
      <Problem problem={typeof said === "string" ? null : said} />
      {quest.state === "open" && canWrite(step) ? (
        <>
          <AppText muted>{t("submission.private")}</AppText>
          <Field
            label={step.kind === "rejected" ? t("submission.sendAgain") : t("submission.label")}
            value={text}
            onChangeText={(value) => setText(value.slice(0, SUBMISSION_TEXT_MAX))}
            multiline
            maxLength={SUBMISSION_TEXT_MAX}
            style={{ minHeight: 96, textAlignVertical: "top" }}
          />
          <AppText muted>
            {t("submission.counter", {
              count: formatNumber(text.trim().length, language),
              max: formatNumber(SUBMISSION_TEXT_MAX, language),
            })}
          </AppText>
          <Button
            label={t("submission.send")}
            disabled={busy || !canSend(text)}
            onPress={() => void send()}
          />
        </>
      ) : null}
    </>
  );
}
