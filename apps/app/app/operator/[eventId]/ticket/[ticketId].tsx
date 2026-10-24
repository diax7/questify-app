import { TICKET_TEXT_MAX, formatEventTime, formatNumber } from "@questify/shared";
import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { Alert, ScrollView, View } from "react-native";
import { api } from "#src/api/app-session.ts";
import { randomUuid } from "#src/api/uuid.ts";
import { AppText } from "#src/components/AppText.tsx";
import { Avatar } from "#src/components/Avatar.tsx";
import { BackButton } from "#src/components/BackButton.tsx";
import { Button, Field, Problem } from "#src/components/Controls.tsx";
import { Screen } from "#src/components/Screen.tsx";
import { canSendTicket, ticketStatusKey } from "#src/event/help.ts";
import { useI18n } from "#src/i18n/provider.tsx";
import { textIn } from "#src/i18n/text.ts";
import {
  answerTicket,
  fetchTicket,
  type AnswerResult,
  type OperatorTicket,
} from "#src/operator/inbox.ts";
import { useOperator } from "#src/operator/OperatorContext.tsx";

/** Reply (one reply closes it) or mark it solved with a confirm; the key is kept until the answer lands. */
function AnswerForm({
  ticket,
  onAnswered,
}: Readonly<{ ticket: OperatorTicket; onAnswered: (result: AnswerResult) => void }>) {
  const { t, language } = useI18n();
  const { eventId } = useOperator();
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState(randomUuid);
  const [failed, setFailed] = useState<AnswerResult | null>(null);
  const send = async (text: string | null) => {
    setBusy(true);
    const result = await answerTicket(api.session, {
      eventId,
      ticketId: ticket.id,
      reply: text,
      key,
    });
    setBusy(false);
    if (result.kind === "done" || result.kind === "gone") {
      setKey(randomUuid());
      onAnswered(result);
      return;
    }
    // A dropped connection keeps the key: trying again cannot answer twice.
    setFailed(result);
  };
  const solve = () =>
    Alert.alert(t("operator.ticket.solve"), t("operator.ticket.solveConfirm"), [
      { text: t("common.cancel"), style: "cancel" },
      { text: t("common.continue"), onPress: () => void send(null) },
    ]);
  return (
    <>
      <AppText muted>{t("operator.ticket.replyHint")}</AppText>
      <Field
        label={t("operator.ticket.reply")}
        value={reply}
        onChangeText={(value) => setReply(value.slice(0, TICKET_TEXT_MAX))}
        multiline
        maxLength={TICKET_TEXT_MAX}
        style={{ minHeight: 96, textAlignVertical: "top" }}
      />
      <AppText muted>
        {t("submission.counter", {
          count: formatNumber(reply.trim().length, language),
          max: formatNumber(TICKET_TEXT_MAX, language),
        })}
      </AppText>
      {failed?.kind === "network" ? (
        <AppText accessibilityRole="alert">{t("join.network")}</AppText>
      ) : null}
      <Problem problem={failed?.kind === "refused" ? failed.message : null} />
      <Button
        label={t("operator.ticket.send")}
        disabled={busy || !canSendTicket(reply)}
        onPress={() => void send(reply)}
      />
      <Button kind="quiet" label={t("operator.ticket.solve")} disabled={busy} onPress={solve} />
    </>
  );
}

/**
 * One help-desk request in staff mode (FR-338, T-310): the text, the quest, the time, and the answer form while it is
 * open. "Already answered" says someone on the team answered first, and goes back to the Inbox.
 */
export default function OperatorTicketScreen() {
  const { t, language } = useI18n();
  const { eventId, event } = useOperator();
  const { ticketId } = useLocalSearchParams<{ ticketId: string }>();
  const [ticket, setTicket] = useState<OperatorTicket | undefined | "failed">(undefined);
  const [said, setSaid] = useState<string | null>(null);
  const load = useCallback(async () => {
    setTicket((await fetchTicket(api.session, eventId, ticketId)) ?? "failed");
  }, [eventId, ticketId]);
  useEffect(() => {
    void load();
  }, [load]);
  const answered = (result: AnswerResult) => {
    if (result.kind === "gone") {
      Alert.alert(t("operator.ticket.alreadyClosed"), undefined, [
        { text: t("common.continue"), onPress: () => router.back() },
      ]);
      return;
    }
    setSaid(t("operator.ticket.done"));
    void load();
  };
  return (
    <Screen title={t("operator.ticket.title")} header={<BackButton />}>
      <ScrollView contentContainerStyle={{ gap: 12 }}>
        {said === null ? null : <AppText accessibilityRole="alert">{said}</AppText>}
        {ticket === undefined ? <AppText muted>{t("common.loading")}</AppText> : null}
        {ticket === "failed" ? (
          <>
            <AppText accessibilityRole="alert">{t("operator.ticket.loadFailed")}</AppText>
            <Button kind="quiet" label={t("common.retry")} onPress={() => void load()} />
          </>
        ) : null}
        {typeof ticket === "object" ? (
          <>
            <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
              <Avatar name={ticket.avatar} username={ticket.username ?? ""} size={32} />
              <AppText variant="label">
                {ticket.username === null ? t("submissions.deletedPlayer") : `@${ticket.username}`}
              </AppText>
              <AppText muted>{t(`help.kind.${ticket.kind}`)}</AppText>
            </View>
            <AppText muted>
              {ticket.quest === null
                ? t("operator.inbox.eventWide")
                : textIn(ticket.quest.title, language)}
            </AppText>
            {event === undefined ? null : (
              <AppText muted>
                {formatEventTime(new Date(ticket.createdAt), event.timezone, language)}
              </AppText>
            )}
            {ticket.marked ? (
              <AppText accessibilityRole="alert">{t("tickets.marked")}</AppText>
            ) : null}
            <AppText>{ticket.text}</AppText>
            <AppText variant="label">{t(ticketStatusKey(ticket))}</AppText>
            {ticket.reply === null ? null : <AppText>{ticket.reply}</AppText>}
            {ticket.status === "open" ? <AnswerForm ticket={ticket} onAnswered={answered} /> : null}
          </>
        ) : null}
      </ScrollView>
    </Screen>
  );
}
