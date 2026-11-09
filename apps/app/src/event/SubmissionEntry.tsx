import { levelUpMessage } from "#src/questify/level.ts";
import {
  JOIN_LINK_HOSTS,
  SUBMISSION_TEXT_MAX,
  formatNumber,
  type LocalizedText,
} from "@questify/shared";
import { useCallback, useEffect, useState } from "react";
import { Linking } from "react-native";
import { api, keyValueStore } from "#src/api/app-session.ts";
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
import {
  fieldLabelKey,
  guidelinesAccepted,
  saidParts,
  showsBox,
  showsClosedNote,
} from "#src/event/submission-entry.ts";
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
    const accepted = await acceptGuidelines({ session: api.session, store: keyValueStore });
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

/** Where the latest submission stands, a note when it cannot be answered again, and what the last send said. */
function SubmissionStatus({
  step,
  line,
  said,
}: Readonly<{ step: SubmissionStep; line: string | null; said: string | LocalizedText | null }>) {
  const { t } = useI18n();
  const parts = saidParts(said);
  return (
    <>
      {line === null ? null : <AppText variant="label">{line}</AppText>}
      {showsClosedNote(step) ? <AppText muted>{t("submission.closed")}</AppText> : null}
      {parts.alert === null ? null : <AppText accessibilityRole="alert">{parts.alert}</AppText>}
      <Problem problem={parts.problem} />
    </>
  );
}

/** The box with its counter and Send; the text and the busy flag stay with the entry. */
function SubmissionBox({
  step,
  text,
  busy,
  onChangeText,
  onSend,
}: Readonly<{
  step: SubmissionStep;
  text: string;
  busy: boolean;
  onChangeText: (value: string) => void;
  onSend: () => void;
}>) {
  const { t, language } = useI18n();
  return (
    <>
      <AppText muted>{t("submission.private")}</AppText>
      <Field
        label={t(fieldLabelKey(step))}
        value={text}
        onChangeText={onChangeText}
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
      <Button label={t("submission.send")} disabled={busy || !canSend(text)} onPress={onSend} />
    </>
  );
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

  // Asked again when the server says the version in force is not accepted yet (a newer one than this app's).
  if (!guidelinesAccepted(state) || guidelines) {
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
      <SubmissionStatus step={step} line={line} said={said} />
      {showsBox(quest.state, step) ? (
        <SubmissionBox
          step={step}
          text={text}
          busy={busy}
          onChangeText={(value) => setText(value.slice(0, SUBMISSION_TEXT_MAX))}
          onSend={() => void send()}
        />
      ) : null}
    </>
  );
}
