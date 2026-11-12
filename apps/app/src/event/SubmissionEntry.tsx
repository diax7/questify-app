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
import { PhotoField, usePhotoDraft, type PhotoDraftState } from "#src/event/PhotoField.tsx";
import { acceptsOf, CAPTION_MAX, canSendPhoto, questPhotoPath } from "#src/event/photos.ts";
import type { Quest } from "#src/event/quests-api.ts";
import {
  acceptGuidelines,
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

/** The text box, or a photo's caption once one is chosen (at most 300 characters), with its counter. */
function TextBox({
  step,
  text,
  captioned,
  onChangeText,
}: Readonly<{
  step: SubmissionStep;
  text: string;
  captioned: boolean;
  onChangeText: (value: string) => void;
}>) {
  const { t, language } = useI18n();
  const max = captioned ? CAPTION_MAX : SUBMISSION_TEXT_MAX;
  return (
    <>
      <Field
        label={t(captioned ? "photo.caption" : fieldLabelKey(step))}
        value={text}
        onChangeText={(value) => onChangeText(value.slice(0, max))}
        multiline
        maxLength={max}
        style={{ minHeight: captioned ? 64 : 96, textAlignVertical: "top" }}
      />
      <AppText muted>
        {t("submission.counter", {
          count: formatNumber(text.trim().length, language),
          max: formatNumber(max, language),
        })}
      </AppText>
    </>
  );
}

/**
 * The box with its counter and Send, and the photo when the quest takes one (T-301b): a photo-only quest shows its
 * caption box once a photo is chosen. The text, the photo and the busy flag stay with the entry.
 */
function SubmissionBox({
  quest,
  step,
  text,
  photos,
  busy,
  onChangeText,
  onSend,
}: Readonly<{
  quest: Quest;
  step: SubmissionStep;
  text: string;
  photos: PhotoDraftState;
  busy: boolean;
  onChangeText: (value: string) => void;
  onSend: () => void;
}>) {
  const { t } = useI18n();
  const accepts = acceptsOf(quest);
  const photo = photos.photo;
  const ready = canSendPhoto(accepts, photo, text);
  return (
    <>
      <AppText muted>{t("submission.private")}</AppText>
      {accepts.photo ? <PhotoField state={photos} disabled={busy} /> : null}
      {accepts.text || photo !== null ? (
        <TextBox step={step} text={text} captioned={photo !== null} onChangeText={onChangeText} />
      ) : null}
      <Button
        label={t("submission.send")}
        disabled={busy || photos.uploading || !ready}
        onPress={onSend}
      />
    </>
  );
}

type Sent = { key: string; text: string };

/** One key per text and photo: a retry repeats both, a change makes a new send. */
const markerOf = (text: string, photoId: string | null) => `${text}\u0000${photoId ?? ""}`;

/**
 * One send: the photo uploaded first when there is one, then the submission with its id and the text as its caption. A
 * photo the server calls unusable (its slot was swept while the player waited) is uploaded again once, with a new key,
 * and sent under the same send key, which the refusal left unused.
 */
async function sendEntry(
  questId: string,
  text: string,
  photos: PhotoDraftState,
  last: Readonly<Sent> | undefined,
): Promise<{ sent: Sent; answer: SendAnswer }> {
  let photoId: string | null = null;
  if (photos.draft !== null) {
    const uploaded = await photos.upload(questPhotoPath(questId));
    if (uploaded.kind !== "uploaded")
      return { sent: last ?? { key: "", text: "" }, answer: uploaded };
    photoId = uploaded.photoId;
  }
  const key = sendKey(last, markerOf(text, photoId), randomUuid);
  const answer = await sendSubmission(api.session, questId, text, key, photoId);
  if (answer.kind !== "refused" || answer.photoUnusable !== true) {
    return { sent: { key, text: markerOf(text, photoId) }, answer };
  }
  const again = await photos.upload(questPhotoPath(questId), true);
  if (again.kind !== "uploaded")
    return { sent: { key, text: markerOf(text, photoId) }, answer: again };
  return {
    sent: { key, text: markerOf(text, again.photoId) },
    answer: await sendSubmission(api.session, questId, text, key, again.photoId),
  };
}

/**
 * A submission quest in the quest sheet (FR-204, FR-206, FR-409, FR-1706, FR-1709): the guidelines the first time, then
 * a box with a counter and, when the quest takes one, a photo (T-301b); afterwards where the latest answer stands. Only
 * the event team sees what is sent (FR-205).
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
  const photos = usePhotoDraft();

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
    setBusy(true);
    const { sent, answer } = await sendEntry(quest.id, text, photos, last);
    setBusy(false);
    setLast(sent);
    if (answer.kind === "guidelines") {
      setGuidelines(true);
      return;
    }
    setSaid(answerLine(answer, t, language));
    if (answer.kind === "sent") {
      setText("");
      photos.clear();
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
          quest={quest}
          step={step}
          text={text}
          photos={photos}
          busy={busy}
          onChangeText={setText}
          onSend={() => void send()}
        />
      ) : null}
    </>
  );
}
