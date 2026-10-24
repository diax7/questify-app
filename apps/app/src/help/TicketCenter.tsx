import {
  TICKET_TEXT_MAX,
  formatNumber,
  type EventTicketKind,
  type LocalizedText,
  type MessageKey,
  type Theme,
} from "@questify/shared";
import Constants from "expo-constants";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { Platform, View } from "react-native";
import { api } from "#src/api/app-session.ts";
import { randomUuid } from "#src/api/uuid.ts";
import { AppText } from "#src/components/AppText.tsx";
import { Button, Field, Problem } from "#src/components/Controls.tsx";
import {
  SENDING_OFF_LINES,
  canSendTicket,
  sendTicket,
  type SendAnswer,
  type SendingOff,
} from "#src/event/help.ts";
import type { MyEvent } from "#src/event/launch.ts";
import { sendKey } from "#src/event/submissions.ts";
import {
  CARD_TITLES,
  CENTER_CARDS,
  EVENT_CHOICES,
  cardNeedsEvent,
  sendLine,
  sendPlatformTicket,
  usernameOf,
  type CenterCard,
} from "#src/help/center.ts";
import { deviceFactsOf, deviceLine, readModelName, type DeviceFacts } from "#src/help/device.ts";
import { useI18n } from "#src/i18n/provider.tsx";
import { textIn } from "#src/i18n/text.ts";
import { useThemedStyles } from "#src/theme/theme.tsx";

/** The event the center sends to: fixed inside an event, or none from the profile (the player picks one). */
export type CenterEvent = Readonly<{ id: string; sendingOff: SendingOff | null | undefined }>;

type Said = Readonly<{ text: string } | { problem: LocalizedText | null }> | null;

/** The phone's facts for an app problem, read once: `expo-device` only now, and never the phone's own name. */
function useDeviceFacts(): DeviceFacts | null | undefined {
  const [facts, setFacts] = useState<DeviceFacts | null | undefined>(undefined);
  useEffect(() => {
    let current = true;
    void readModelName(() => import("expo-device")).then((modelName) => {
      if (current) {
        setFacts(
          deviceFactsOf({
            appVersion: Constants.expoConfig?.version,
            os: Platform.OS,
            osVersion: Platform.Version,
            modelName,
            androidModel: (Platform.constants as { Model?: string } | undefined)?.Model,
          }),
        );
      }
    });
    return () => {
      current = false;
    };
  }, []);
  return facts;
}

type FormProps = Readonly<{
  card: CenterCard;
  eventId: string | null;
  questId: string | null;
  questTitle: string | null;
  initialKind: EventTicketKind | null;
  onSent: () => void;
  onOff: (why: SendingOff) => void;
}>;

/** The kind a card sends, from its choice; null until the player picks one of the event card's three. */
const kindOf = (card: CenterCard, chosen: EventTicketKind | null) =>
  card === "report"
    ? "report_player"
    : card === "app"
      ? "app_problem"
      : card === "suggestion"
        ? "suggestion"
        : chosen;

const PLACEHOLDERS: Readonly<Record<string, MessageKey>> = {
  report_player: "help.placeholder.report",
  question: "help.placeholder.question",
  prize: "help.placeholder.problem",
  problem: "help.placeholder.problem",
  app_problem: "help.placeholder.app",
  suggestion: "help.placeholder.suggestion",
};

/** Sends one card's request with one Idempotency-Key per text, kept after a failure so Retry cannot send twice. */
function useSend(props: FormProps, facts: DeviceFacts | null | undefined) {
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<{ key: string; text: string } | undefined>(undefined);
  const send = async (kind: string, text: string, username: string): Promise<SendAnswer> => {
    const signature = `${kind}:${username}:${text}`;
    const key = sendKey(last, signature, randomUuid);
    setBusy(true);
    const answer =
      kind === "app_problem" || kind === "suggestion"
        ? await sendPlatformTicket(api.session, { kind, text, device: facts ?? null, key })
        : await sendTicket(api.session, {
            eventId: props.eventId ?? "",
            kind: kind as EventTicketKind,
            questId: kind === "report_player" ? null : props.questId,
            ...(kind === "report_player" ? { reportedUsername: usernameOf(username) } : {}),
            text,
            key,
          });
    setBusy(false);
    setLast(answer.kind === "sent" ? undefined : { key, text: signature });
    return answer;
  };
  return { busy, retrying: last !== undefined, send };
}

/** The request's box and its counter, bounded as the server bounds it. */
function TextBox({
  label,
  placeholder,
  text,
  onChange,
}: Readonly<{
  label: string;
  placeholder: string;
  text: string;
  onChange: (text: string) => void;
}>) {
  const { t, language } = useI18n();
  return (
    <>
      <Field
        label={label}
        placeholder={placeholder}
        value={text}
        onChangeText={(value) => onChange(value.slice(0, TICKET_TEXT_MAX))}
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
    </>
  );
}

/** One card's form: the report's username, the event card's three choices, the device line, the privacy line. */
function CardForm(props: FormProps) {
  const { t } = useI18n();
  const facts = useDeviceFacts();
  const [chosen, setChosen] = useState<EventTicketKind | null>(props.initialKind);
  const [text, setText] = useState("");
  const [username, setUsername] = useState("");
  const [said, setSaid] = useState<Said>(null);
  const { busy, retrying, send } = useSend(props, facts);
  const kind = kindOf(props.card, chosen);
  const toQuestify = !cardNeedsEvent(props.card);
  const ready =
    kind !== null &&
    canSendTicket(text) &&
    (kind !== "report_player" || usernameOf(username).length >= 3) &&
    (kind !== "app_problem" || facts !== null);
  const go = async () => {
    if (kind === null) {
      return;
    }
    const answer = await send(kind, text, username);
    if (answer.kind === "off") {
      props.onOff(answer.why);
      return;
    }
    if (answer.kind === "sent") {
      setText("");
      setUsername("");
      props.onSent();
    }
    const line = sendLine(answer, toQuestify);
    setSaid(
      answer.kind === "refused"
        ? { problem: answer.message }
        : line === null
          ? null
          : { text: t(line) },
    );
  };
  return (
    <>
      {props.card === "event"
        ? EVENT_CHOICES.map((choice) => (
            <Button
              key={choice.kind}
              label={t(choice.label)}
              kind={chosen === choice.kind ? "primary" : "quiet"}
              onPress={() => setChosen(choice.kind)}
            />
          ))
        : null}
      {said !== null && "text" in said ? (
        <AppText accessibilityRole="alert">{said.text}</AppText>
      ) : null}
      <Problem problem={said !== null && "problem" in said ? said.problem : null} />
      {kind === null ? null : (
        <>
          {props.questTitle === null || kind === "report_player" ? null : (
            <AppText muted>{t("help.aboutQuest", { quest: props.questTitle })}</AppText>
          )}
          {kind === "report_player" ? (
            <>
              <Field
                label={t("help.report.username")}
                value={username}
                onChangeText={(value) => setUsername(value.slice(0, 31))}
                autoCapitalize="none"
                autoCorrect={false}
              />
              <AppText muted>{t("help.report.anonymous")}</AppText>
            </>
          ) : null}
          <AppText muted>{t(toQuestify ? "help.private.questify" : "help.private.event")}</AppText>
          <TextBox
            label={t(CARD_TITLES[props.card])}
            placeholder={t(PLACEHOLDERS[kind] ?? "help.placeholder.question")}
            text={text}
            onChange={setText}
          />
          {kind === "app_problem" && facts !== null && facts !== undefined ? (
            <AppText muted>{t("help.device.sentWith", { facts: deviceLine(facts) })}</AppText>
          ) : null}
          {canSendTicket(text) ? null : <AppText muted>{t("help.textRequired")}</AppText>}
          <Button
            label={retrying ? t("common.retry") : t("help.send")}
            disabled={busy || !ready}
            onPress={() => void go()}
          />
        </>
      )}
    </>
  );
}

/** From the profile, an event card asks which event: the player's active ones, or "Join an event to use this". */
function EventPicker({
  card,
  events,
}: Readonly<{ card: CenterCard; events: readonly MyEvent[] | undefined }>) {
  const { t, language } = useI18n();
  if (events === undefined) {
    return <AppText muted>{t("common.loading")}</AppText>;
  }
  const active = events.filter((event) => event.status === "active");
  if (active.length === 0) {
    return <AppText muted>{t("help.needEvent")}</AppText>;
  }
  return (
    <>
      <AppText variant="label">{t("help.pickEvent")}</AppText>
      {active.map((event) => (
        <Button
          key={event.id}
          kind="quiet"
          label={textIn(event.name, language)}
          onPress={() => router.push(`/event/${event.id}/help?card=${card}`)}
        />
      ))}
    </>
  );
}

export type TicketCenterProps = Readonly<{
  event: CenterEvent | null;
  /** The player's events, for the picker when there is no fixed event. */
  events?: readonly MyEvent[] | undefined;
  initial?:
    | Readonly<{
        card: CenterCard;
        kind: EventTicketKind | null;
        questId: string | null;
        questTitle: string | null;
      }>
    | undefined;
  onSent: () => void;
  onOff: (why: SendingOff) => void;
}>;

/**
 * The ticket center (T-312, F-324, FR-1822): four cards, each saying who receives it. Report a player and Question or
 * problem at the event need an event (the fixed one, or one picked from the player's events) and hide while sending
 * is off there, with the reason; App problem and Suggestion go to Questify and are always on.
 */
export function TicketCenter({ event, events, initial, onSent, onOff }: TicketCenterProps) {
  const { t } = useI18n();
  const styles = useThemedStyles(makeStyles);
  const [open, setOpen] = useState<CenterCard | null>(initial?.card ?? null);
  return (
    <>
      <AppText variant="title">{t("help.center.title")}</AppText>
      {CENTER_CARDS.map((card) => {
        const needsEvent = cardNeedsEvent(card);
        const off = needsEvent ? event?.sendingOff : null;
        return (
          <View key={card} style={styles.card} testID={`help-card-${card}`}>
            <Button
              kind={open === card ? "primary" : "quiet"}
              label={t(CARD_TITLES[card])}
              onPress={() => setOpen(open === card ? null : card)}
            />
            <AppText muted>{t(needsEvent ? "help.to.event" : "help.to.questify")}</AppText>
            {open !== card ? null : needsEvent && event === null ? (
              <EventPicker card={card} events={events} />
            ) : off !== null && off !== undefined ? (
              <AppText accessibilityRole="alert">{t(SENDING_OFF_LINES[off])}</AppText>
            ) : off === undefined ? (
              <AppText muted>{t("common.loading")}</AppText>
            ) : (
              <CardForm
                card={card}
                eventId={needsEvent ? (event?.id ?? null) : null}
                questId={initial?.card === card ? initial.questId : null}
                questTitle={initial?.card === card ? initial.questTitle : null}
                initialKind={initial?.card === card ? initial.kind : null}
                onSent={onSent}
                onOff={onOff}
              />
            )}
          </View>
        );
      })}
    </>
  );
}

const makeStyles = (theme: Theme) => ({
  card: {
    gap: theme.spacing.sm,
    padding: theme.spacing.md,
    borderRadius: theme.radius.md,
    borderWidth: 2,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
});
