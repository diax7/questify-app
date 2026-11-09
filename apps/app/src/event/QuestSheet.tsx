import {
  QUEST_TYPES,
  formatEventTime,
  formatNumber,
  isQuestType,
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
import { scanReading } from "#src/event/location.ts";
import { FirstBonusRibbon } from "#src/event/FirstBonusRibbon.tsx";
import { GameEntry } from "#src/event/GameEntry.tsx";
import { LocationEntry, useLocationReader } from "#src/event/LocationEntry.tsx";
import { MeetEntry } from "#src/event/MeetEntry.tsx";
import { PassportEntry } from "#src/event/PassportEntry.tsx";
import { QuestRating } from "#src/event/QuestRating.tsx";
import { QuizEntry } from "#src/event/QuizEntry.tsx";
import { ShareEntry } from "#src/event/ShareEntry.tsx";
import { SubmissionEntry } from "#src/event/SubmissionEntry.tsx";
import { SurveyEntry } from "#src/event/SurveyEntry.tsx";
import { VoteEntry } from "#src/event/VoteEntry.tsx";
import { useEvent, useTerms } from "#src/event/EventContext.tsx";
import {
  completeQuest,
  keyFor,
  type Attempt,
  type CompletionAnswer,
  type Quest,
  scanFallback,
} from "#src/event/quests-api.ts";
import { LOCK_TEXT, outcomeText } from "#src/event/outcome-text.ts";
import { unlockLine } from "#src/event/unlock.ts";
import { useNfcSupported } from "#src/nfc/NfcTap.tsx";
import { useI18n } from "#src/i18n/provider.tsx";
import { textIn } from "#src/i18n/text.ts";
import { ReportButton } from "#src/questify/ReportButton.tsx";

/** The line under a quest that says why it cannot be played now, or nothing when it is open. */
export function stateLine(quest: Pick<Quest, "type" | "state" | "lock">): MessageKey | null {
  if (!isQuestType(quest.type)) {
    return "questsTab.unknown";
  }
  if (quest.state === "locked") {
    return quest.lock === null ? "questsTab.locked" : LOCK_TEXT[quest.lock];
  }
  if (quest.state === "not_yet" || quest.state === "open") {
    return null;
  }
  return STATE_TEXT[quest.state] ?? "questsTab.unknown";
}

/** The line of each state that is not locked, open or about to open; a state this build does not know has none. */
const STATE_TEXT: Readonly<Record<string, MessageKey>> = {
  done: "questsTab.done",
  not_live: "questsTab.notLive",
  paused: "questsTab.paused",
  closed: "questsTab.closed",
};

/** Letters and digits only as typed (Arabic-Indic digits pass and the server makes them Western). */
const typedCode = (text: string) => text.replace(/[^A-Za-z0-9٠-٩۰-۹]/g, "").slice(0, 32);

/** Typing an entry code (FR-202, FR-1742) with the Idempotency-Key rule of `keyFor`. */
function CodeEntry({
  quest,
  onDone,
}: Readonly<{ quest: Quest; onDone: (answer: CompletionAnswer) => void }>) {
  const { t } = useI18n();
  const { scanPositions } = useEvent();
  const reader = useLocationReader();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<Attempt | undefined>(undefined);
  const submit = async () => {
    const key = keyFor(last, code, randomUuid);
    setBusy(true);
    const position = await scanReading(reader ?? null, scanPositions, Date.now);
    const answer = await completeQuest(
      api.session,
      quest.id,
      { type: "code", code, ...(position === null ? {} : { position }) },
      key,
    );
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
/** T-309b: a kiosk quest opens My QR on For kiosks, where the live code a kiosk reads is shown. */
function KioskAction({ primary }: Readonly<{ primary: boolean }>) {
  const { t } = useI18n();
  return (
    <Button
      kind={primary ? "primary" : "quiet"}
      label={t("quests.action.kiosk")}
      onPress={() => router.push({ pathname: "/my-qr", params: { tab: "kiosk" } })}
    />
  );
}

function Verification({
  quest,
  onDone,
}: Readonly<{ quest: Quest; onDone: (answer: CompletionAnswer) => void }>) {
  const { t } = useI18n();
  const { eventId, nfcOn } = useEvent();
  const nfcSupported = useNfcSupported();
  const scanButton = (
    <Button
      label={t("questsTab.scan")}
      onPress={() =>
        router.push({
          pathname: "/event/[eventId]/scan-quest",
          params: { eventId, quest: quest.id },
        })
      }
    />
  );
  if (scanFallback(quest)) {
    return scanButton;
  }
  if (quest.state !== "open" || !isQuestType(quest.type)) {
    return null;
  }
  if (quest.type === "enter_code") {
    return <CodeEntry quest={quest} onDone={onDone} />;
  }
  // These types play in their own entry below the sheet's details.
  const staff = quest.verification.includes("my_qr");
  // T-205: a quest staff verify shows My QR; with no printed code it offers nothing else. A challenge is only ever
  // confirmed by staff (ADR-197).
  const showMyQr = staff ? (
    <>
      <AppText variant="label">
        {t(quest.type === "challenge" ? "play.challenge.staff" : "quests.showMyQr")}
      </AppText>
      <Button
        kind={quest.verification.includes("quest_qr") ? "quiet" : "primary"}
        label={t("myQr.title")}
        onPress={() => router.push("/my-qr")}
      />
    </>
  ) : null;
  const kiosk = quest.verification.includes("kiosk") ? (
    <KioskAction primary={quest.verification.length === 1} />
  ) : null;
  // T-309: a quest whose code is shown on a station's screen (never with a printed one) is scanned from the scanner.
  if (quest.verification.includes("screen_qr")) {
    return (
      <>
        {showMyQr}
        <AppText variant="label">{t("quests.action.scanScreen")}</AppText>
        {scanButton}
        {kiosk}
      </>
    );
  }
  if (!quest.verification.includes("quest_qr")) {
    return (
      <>
        {showMyQr}
        {kiosk}
      </>
    );
  }
  // FR-313: a tag where NFC is on, the phone reads tags and the quest offers one; its QR stays below as the backup.
  const tapButton =
    nfcOn && nfcSupported === true && quest.verification.includes("nfc") ? (
      <Button
        label={t("quests.action.tapNfc")}
        onPress={() =>
          router.push({
            pathname: "/event/[eventId]/scan-quest",
            params: { eventId, quest: quest.id, nfc: "1" },
          })
        }
      />
    ) : null;
  return (
    <>
      {showMyQr}
      {tapButton}
      <AppText variant="label">{t("questsTab.verifyScan")}</AppText>
      {scanButton}
      {kiosk}
    </>
  );
}

/** The part of the sheet where the quest is played, by its type. */
function QuestEntry({
  quest,
  timeZone,
  onSent,
  onDone,
}: Readonly<{
  quest: Quest;
  timeZone: string;
  onSent: () => void;
  onDone: (answer: CompletionAnswer) => void;
}>) {
  switch (quest.type) {
    case "submission":
      return <SubmissionEntry key={quest.id} quest={quest} onSent={onSent} />;
    case "vote":
      return <VoteEntry key={quest.id} quest={quest} onPaid={onSent} />;
    case "quiz":
      return <QuizEntry key={quest.id} quest={quest} onPaid={onSent} />;
    case "survey":
      return <SurveyEntry key={quest.id} quest={quest} onPaid={onSent} />;
    case "share":
      return <ShareEntry key={quest.id} quest={quest} onPaid={onSent} />;
    case "passport":
      return <PassportEntry key={quest.id} quest={quest} />;
    case "location":
      return <LocationEntry key={quest.id} quest={quest} onDone={onDone} />;
    case "meet":
      return <MeetEntry key={quest.id} quest={quest} onPaid={onSent} />;
    case "game":
      return <GameEntry key={quest.id} quest={quest} timeZone={timeZone} onPaid={onSent} />;
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
  /** A submission was sent, a vote cast, a quiz, a survey, a share, a meeting or a game paid: the list behind reloads. */
  onSent?: () => void;
}>) {
  const { t, language } = useI18n();
  const terms = useTerms();
  const { eventId, helpOn } = useEvent();
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
  const stateKey = stateLine(quest);
  // A community lock names its goal's numbers (T-306c, ADR-228); the target itself stays shut, no entry below.
  const unlock =
    quest.state === "locked" && quest.communityLock !== null
      ? unlockLine(quest.communityLock, language, timeZone)
      : null;
  const line =
    unlock === null ? (stateKey === null ? null : t(stateKey)) : t(unlock.key, unlock.values);
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
      <FirstBonusRibbon questId={quest.id} bonus={quest.firstBonus} />
      {quest.repeatCap > 1 && quest.type !== "meet" ? (
        <AppText>{t("questsTab.repeat", { done: quest.done, cap: quest.repeatCap })}</AppText>
      ) : null}
      {when(quest.opensAt, "quests.opens")}
      {when(quest.closesAt, "quests.closes")}
      {line === null ? null : <AppText variant="label">{line}</AppText>}
      {outcome === null ? null : <AppText accessibilityRole="alert">{outcome}</AppText>}
      <QuestEntry quest={quest} timeZone={timeZone} onSent={onSent} onDone={done} />
      <QuestRating key={quest.id} quest={quest} />
      <ReportButton subject={{ kind: "quest", targetId: quest.id }} />
      {helpOn ? (
        <Button
          kind="quiet"
          label={t("help.reportQuest")}
          onPress={() => {
            onClose();
            router.push({
              pathname: "/event/[eventId]/help",
              params: {
                eventId,
                kind: "problem",
                questId: quest.id,
                questTitle: textIn(quest.title, language),
              },
            });
          }}
        />
      ) : null}
    </Sheet>
  );
}
