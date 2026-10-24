import {
  JOIN_LINK_HOSTS,
  TICKET_TEXT_MAX,
  formatNumber,
  type LocalizedText,
  type TicketKind,
} from "@questify/shared";
import { useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { Linking, ScrollView } from "react-native";
import { api } from "#src/api/app-session.ts";
import { randomUuid } from "#src/api/uuid.ts";
import { AppText } from "#src/components/AppText.tsx";
import { BackButton } from "#src/components/BackButton.tsx";
import { Button, Field, Problem } from "#src/components/Controls.tsx";
import { Screen } from "#src/components/Screen.tsx";
import { useEvent } from "#src/event/EventContext.tsx";
import {
  SENDING_OFF_LINES,
  canSendTicket,
  fetchMyTickets,
  markSeen,
  sendTicket,
  sendingOffFor,
  type MyTicket,
  type SendingOff,
} from "#src/event/help.ts";
import { fetchHome } from "#src/event/home-api.ts";
import { RequestList } from "#src/event/Requests.tsx";
import { sendKey } from "#src/event/submissions.ts";
import { useI18n } from "#src/i18n/provider.tsx";

type Said = Readonly<{ text: string } | { problem: LocalizedText | null }> | null;

/**
 * The form: Ask a question or Report a problem, a box with a counter, "Only you and the event team can see this", and
 * Send with one Idempotency-Key per text (a failed send keeps the text and the key, so Retry cannot send twice).
 */
function HelpForm({
  questId,
  questTitle,
  initialKind,
  onSent,
  onOff,
}: Readonly<{
  questId: string | null;
  questTitle: string | null;
  initialKind: TicketKind | null;
  onSent: () => void;
  onOff: (why: SendingOff) => void;
}>) {
  const { t, language } = useI18n();
  const { eventId } = useEvent();
  const [kind, setKind] = useState<TicketKind | null>(initialKind);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<{ key: string; text: string } | undefined>(undefined);
  const [said, setSaid] = useState<Said>(null);
  const send = async (chosen: TicketKind) => {
    const key = sendKey(last, `${chosen}:${text}`, randomUuid);
    setBusy(true);
    const answer = await sendTicket(api.session, { eventId, kind: chosen, questId, text, key });
    setBusy(false);
    setLast({ key, text: `${chosen}:${text}` });
    if (answer.kind === "sent") {
      setText("");
      setLast(undefined);
      setSaid({ text: t("help.sent") });
      onSent();
      return;
    }
    if (answer.kind === "off") {
      onOff(answer.why);
      return;
    }
    const lines = {
      too_many_open: "help.tooManyOpen",
      too_many: "help.tooMany",
      network: "join.network",
    } as const;
    if (answer.kind === "refused") {
      setSaid({ problem: answer.message });
    } else if (answer.kind !== "signed_out") {
      setSaid({ text: t(lines[answer.kind]) });
    }
  };
  return (
    <>
      <Button
        label={t("help.ask")}
        kind={kind === "question" ? "primary" : "quiet"}
        onPress={() => setKind("question")}
      />
      <Button
        label={questId === null ? t("help.report") : t("help.reportQuest")}
        kind={kind === "problem" ? "primary" : "quiet"}
        onPress={() => setKind("problem")}
      />
      {said !== null && "text" in said ? (
        <AppText accessibilityRole="alert">{said.text}</AppText>
      ) : null}
      <Problem problem={said !== null && "problem" in said ? said.problem : null} />
      {kind === null ? null : (
        <>
          {questTitle === null ? null : (
            <AppText muted>{t("help.aboutQuest", { quest: questTitle })}</AppText>
          )}
          <AppText muted>{t("help.private")}</AppText>
          <Field
            label={t(kind === "question" ? "help.ask" : "help.report")}
            placeholder={t(
              kind === "question" ? "help.placeholder.question" : "help.placeholder.problem",
            )}
            value={text}
            onChangeText={(value) => setText(value.slice(0, TICKET_TEXT_MAX))}
            multiline
            maxLength={TICKET_TEXT_MAX}
            style={{ minHeight: 96, textAlignVertical: "top" }}
          />
          <AppText muted>
            {t("submission.counter", {
              count: formatNumber(text.trim().length, language),
              max: formatNumber(TICKET_TEXT_MAX, language),
            })}
          </AppText>
          {canSendTicket(text) ? null : <AppText muted>{t("help.textRequired")}</AppText>}
          <Button
            label={last === undefined ? t("help.send") : t("common.retry")}
            disabled={busy || !canSendTicket(text)}
            onPress={() => void send(kind)}
          />
        </>
      )}
    </>
  );
}

/** The player's requests in this event and whether sending is off, read on open and after each send. */
function useHelp(eventId: string, helpOn: boolean) {
  const [tickets, setTickets] = useState<MyTicket[] | undefined | "failed">(undefined);
  const [off, setOff] = useState<SendingOff | null | undefined>(undefined);
  const load = useCallback(async () => {
    const [mine, home] = await Promise.all([
      fetchMyTickets(api.session, eventId),
      fetchHome(api.session, eventId),
    ]);
    setTickets(mine ?? "failed");
    if (home.kind === "home") {
      const { standing, event } = home.home;
      setOff(
        sendingOffFor(
          { helpOn, standing: standing.status, statusNow: event.statusNow, endsAt: event.endsAt },
          Date.now(),
        ),
      );
    } else if (home.kind === "gone") {
      setOff("not_member");
    }
    if (mine !== undefined) {
      // Showing the list is seeing the answers on it; a failure is marked again next time.
      void markSeen(api.session, eventId, mine).catch(() => undefined);
    }
  }, [eventId, helpOn]);
  useEffect(() => {
    void load();
  }, [load]);
  return { tickets, off, setOff, load };
}

/**
 * Get help (T-310, FR-337 to FR-339): the form, when sending is open for this player, and Your requests in every state
 * (with the switch off, after leaving, or once sending closed: only the form hides, with a line saying why). A problem
 * with the app itself goes to Questify's contact page.
 */
export default function HelpScreen() {
  const { t, language } = useI18n();
  const { eventId, helpOn } = useEvent();
  const params = useLocalSearchParams<{ kind?: string; questId?: string; questTitle?: string }>();
  const { tickets, off, setOff, load } = useHelp(eventId, helpOn);
  const initialKind = params.kind === "problem" || params.kind === "question" ? params.kind : null;
  return (
    <Screen title={t("help.title")} header={<BackButton />}>
      <ScrollView contentContainerStyle={{ gap: 12 }}>
        {off === null ? (
          <HelpForm
            questId={params.questId ?? null}
            questTitle={params.questTitle ?? null}
            initialKind={initialKind}
            onSent={() => void load()}
            onOff={setOff}
          />
        ) : null}
        {off === null || off === undefined ? null : (
          <AppText accessibilityRole="alert">{t(SENDING_OFF_LINES[off])}</AppText>
        )}
        {tickets === undefined ? <AppText muted>{t("common.loading")}</AppText> : null}
        {tickets === "failed" ? (
          <>
            <AppText accessibilityRole="alert">{t("help.loadFailed")}</AppText>
            <Button kind="quiet" label={t("common.retry")} onPress={() => void load()} />
          </>
        ) : null}
        {Array.isArray(tickets) ? <RequestList tickets={tickets} /> : null}
        <Button
          kind="quiet"
          label={t("help.appProblem")}
          onPress={() => void Linking.openURL(`https://${JOIN_LINK_HOSTS[0]}/${language}/contact`)}
        />
      </ScrollView>
    </Screen>
  );
}
