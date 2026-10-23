import {
  QUEST_TYPES,
  formatEventTime,
  formatNumber,
  isQuestType,
  type EventTerms,
  type MessageKey,
} from "@questify/shared";
import { router } from "expo-router";
import { useState } from "react";
import { api } from "#src/api/app-session.ts";
import { randomUuid } from "#src/api/uuid.ts";
import { Amount } from "#src/components/Amount.tsx";
import { AppText } from "#src/components/AppText.tsx";
import { Button, Field } from "#src/components/Controls.tsx";
import { Sheet } from "#src/components/Sheet.tsx";
import { spanText } from "#src/event/countdown.ts";
import { completedText } from "#src/event/amount.ts";
import { QuizEntry } from "#src/event/QuizEntry.tsx";
import { SubmissionEntry } from "#src/event/SubmissionEntry.tsx";
import { VoteEntry } from "#src/event/VoteEntry.tsx";
import { useEvent, useTerms } from "#src/event/EventContext.tsx";
import {
  completeQuest,
  keyFor,
  type Attempt,
  type CompletionAnswer,
  type NotOpenReason,
  type Quest,
} from "#src/event/quests-api.ts";
import { useI18n } from "#src/i18n/provider.tsx";
import { textIn } from "#src/i18n/text.ts";

/** The line under a quest that says why it cannot be played now, or nothing when it is open. */
export function stateLine(quest: Pick<Quest, "type" | "state">): MessageKey | null {
  if (!isQuestType(quest.type)) {
    return "questsTab.unknown";
  }
  switch (quest.state) {
    case "done":
      return "questsTab.done";
    case "not_live":
      return "questsTab.notLive";
    case "closed":
      return "questsTab.closed";
    case "not_yet":
    case "open":
      return null;
    default:
      return "questsTab.unknown";
  }
}

const NOT_OPEN_TEXT: Readonly<Record<NotOpenReason, MessageKey>> = {
  event_not_live: "questsTab.notOpen.eventNotLive",
  hidden: "questsTab.notOpen.hidden",
  not_started: "questsTab.notOpen.notStarted",
  ended: "questsTab.notOpen.ended",
  not_for_you: "questsTab.notOpen.notForYou",
};

/** Letters and digits only as typed (Arabic-Indic digits pass and the server makes them Western). */
const typedCode = (text: string) => text.replace(/[^A-Za-z0-9٠-٩۰-۹]/g, "").slice(0, 32);

export function outcomeText(
  answer: CompletionAnswer,
  t: ReturnType<typeof useI18n>["t"],
  language: "ar" | "en",
  terms: EventTerms,
): string | null {
  switch (answer.kind) {
    case "completed": {
      const paid = completedText(t, terms, language, answer.points);
      // FR-407: a level-up reached here (a typed code) is said in words; the scanner gives it its own beat.
      return answer.levelUp === null
        ? paid
        : `${paid} ${t("level.upLine", { level: answer.levelUp.level, title: answer.levelUp.title[language] })}`;
    }
    case "wrong_code":
      return answer.problem?.[language] ?? t("questsTab.failed");
    case "not_open":
      return answer.reason === undefined ? t("questsTab.notLive") : t(NOT_OPEN_TEXT[answer.reason]);
    case "limit":
      return t("questsTab.limit");
    case "wait": {
      const span = answer.seconds === null ? null : spanText(answer.seconds * 1000, language);
      return span === null ? t("questsTab.waitSoon") : t("questsTab.wait", { span });
    }
    case "network":
      return t("join.network");
    case "failed":
      return t("questsTab.failed");
    case "reload":
    case "signed_out":
      return null;
  }
}

/** Typing an entry code (FR-202, FR-1742) with the Idempotency-Key rule of `keyFor`. */
function CodeEntry({
  quest,
  onDone,
}: Readonly<{ quest: Quest; onDone: (answer: CompletionAnswer) => void }>) {
  const { t } = useI18n();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<Attempt | undefined>(undefined);
  const submit = async () => {
    const key = keyFor(last, code, randomUuid);
    setBusy(true);
    const answer = await completeQuest(api.session, quest.id, { type: "code", code }, key);
    setBusy(false);
    setLast({ key, code, retryable: answer.kind === "network" });
    // A repeatable quest starts again from an empty field.
    if (answer.kind === "completed") {
      setCode("");
    }
    onDone(answer);
  };
  return (
    <>
      <AppText variant="label">{t("questsTab.verifyCode")}</AppText>
      <Field
        label={t("questsTab.codeLabel")}
        value={code}
        onChangeText={(text) => setCode(typedCode(text))}
        autoCapitalize="characters"
        autoCorrect={false}
        style={{ writingDirection: "ltr", textAlign: "left" }}
      />
      <AppText muted>{t("questsTab.codeHint")}</AppText>
      <Button
        label={t("questsTab.submit")}
        disabled={busy || code.length < 4}
        onPress={() => void submit()}
      />
    </>
  );
}

/** How a quest is verified, with its action (FR-1742); only an open quest of a known type offers it. */
function Verification({
  quest,
  onDone,
}: Readonly<{ quest: Quest; onDone: (answer: CompletionAnswer) => void }>) {
  const { t } = useI18n();
  const { eventId } = useEvent();
  if (quest.state !== "open" || !isQuestType(quest.type)) {
    return null;
  }
  if (quest.type === "enter_code") {
    return <CodeEntry quest={quest} onDone={onDone} />;
  }
  // These types play in their own entry below the sheet's details.
  if (quest.type === "submission" || quest.type === "vote" || quest.type === "quiz") {
    return null;
  }
  const staff = quest.verification.includes("my_qr");
  // T-205: a quest staff verify shows My QR; with no printed code it offers nothing else.
  const showMyQr = staff ? (
    <>
      <AppText variant="label">{t("quests.showMyQr")}</AppText>
      <Button
        kind={quest.verification.includes("quest_qr") ? "quiet" : "primary"}
        label={t("myQr.title")}
        onPress={() => router.push("/my-qr")}
      />
    </>
  ) : null;
  if (!quest.verification.includes("quest_qr")) {
    return showMyQr;
  }
  return (
    <>
      {showMyQr}
      <AppText variant="label">{t("questsTab.verifyScan")}</AppText>
      <Button
        label={t("questsTab.scan")}
        onPress={() =>
          router.push({
            pathname: "/event/[eventId]/scan-quest",
            params: { eventId, quest: quest.id },
          })
        }
      />
    </>
  );
}

/** The part of the sheet where the quest is played, by its type. */
function QuestEntry({
  quest,
  onSent,
  onDone,
}: Readonly<{ quest: Quest; onSent: () => void; onDone: (answer: CompletionAnswer) => void }>) {
  switch (quest.type) {
    case "submission":
      return <SubmissionEntry key={quest.id} quest={quest} onSent={onSent} />;
    case "vote":
      return <VoteEntry key={quest.id} quest={quest} onPaid={onSent} />;
    case "quiz":
      return <QuizEntry key={quest.id} quest={quest} onPaid={onSent} />;
    default:
      return <Verification key={quest.id} quest={quest} onDone={onDone} />;
  }
}

/**
 * A quest's details (FR-222): what to do, the reward, its window in the event's zone, the repeat progress, and how it
 * is verified. Sections the quest does not have (steps, tips, location, time, difficulty: Q-102) are not shown.
 */
export function QuestSheet({
  quest,
  timeZone,
  onClose,
  onCompleted,
  onSent = () => undefined,
}: Readonly<{
  quest: Quest | undefined;
  timeZone: string;
  onClose: () => void;
  onCompleted: (answer: CompletionAnswer) => void;
  /** A submission was sent, a vote cast or a quiz paid: the list behind the sheet reloads. */
  onSent?: () => void;
}>) {
  const { t, language } = useI18n();
  const terms = useTerms();
  // Kept here, not in the code field: a success turns the quest to done and the field goes, its message stays.
  const [outcome, setOutcome] = useState<string | null>(null);
  if (quest === undefined) {
    return null;
  }
  const done = (answer: CompletionAnswer) => {
    setOutcome(outcomeText(answer, t, language, terms));
    onCompleted(answer);
  };
  const description = textIn(quest.description, language);
  const line = stateLine(quest);
  const when = (iso: string | null, key: "quests.opens" | "quests.closes") =>
    iso === null ? null : (
      <AppText muted>
        {t(key, { time: formatEventTime(new Date(iso), timeZone, language) })}
      </AppText>
    );
  return (
    <Sheet visible title={textIn(quest.title, language)} onClose={onClose}>
      {isQuestType(quest.type) ? <AppText muted>{t(QUEST_TYPES[quest.type].label)}</AppText> : null}
      {description === "" ? null : <AppText>{description}</AppText>}
      <Amount amount={formatNumber(quest.points, language)} form="labelled" variant="label" />
      {quest.repeatCap > 1 ? (
        <AppText>{t("questsTab.repeat", { done: quest.done, cap: quest.repeatCap })}</AppText>
      ) : null}
      {when(quest.opensAt, "quests.opens")}
      {when(quest.closesAt, "quests.closes")}
      {line === null ? null : <AppText variant="label">{t(line)}</AppText>}
      {outcome === null ? null : <AppText accessibilityRole="alert">{outcome}</AppText>}
      <QuestEntry quest={quest} onSent={onSent} onDone={done} />
    </Sheet>
  );
}
