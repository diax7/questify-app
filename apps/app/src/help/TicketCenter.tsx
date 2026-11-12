import { TICKET_TEXT_MAX, formatNumber, type EventTicketKind, type Theme } from "@questify/shared";
import Constants from "expo-constants";
import { router } from "expo-router";
import { useContext, useEffect, useState } from "react";
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
import {
  PhotoField,
  PhotosOn,
  usePhotoDraft,
  type PhotoDraftState,
} from "#src/event/PhotoField.tsx";
import { ticketPhotoPath } from "#src/event/photos.ts";
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
import {
  deviceFactsOf,
  loadExpoDevice,
  readModelName,
  type DeviceFacts,
} from "#src/help/device.ts";
import {
  cardBodyOf,
  deviceNoteOf,
  isReady,
  kindOf,
  placeholderKey,
  questLineOf,
  saidFor,
  saidProblem,
  saidText,
  type CardBody,
  type CenterInitial,
  type Said,
} from "#src/help/ticket-form.ts";
import { useI18n } from "#src/i18n/provider.tsx";
import { textIn } from "#src/i18n/text.ts";
import { useThemedStyles } from "#src/theme/theme.tsx";

/** The event the center sends to: fixed inside an event, or none from the profile (the player picks one). */
export type CenterEvent = Readonly<{ id: string; sendingOff: SendingOff | null | undefined }>;

/** The phone's facts for an app problem, read once: `expo-device` only now, and never the phone's own name. */
function useDeviceFacts(): DeviceFacts | null | undefined {
  const [facts, setFacts] = useState<DeviceFacts | null | undefined>(undefined);
  useEffect(() => {
    let current = true;
    void readModelName(loadExpoDevice).then((modelName) => {
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

/**
 * An event request's photo, uploaded first when there is one (T-301b); its id, or why it could not be sent. `fresh`
 * uploads it again with a new key.
 */
async function photoFor(
  photos: PhotoDraftState,
  eventId: string,
  fresh = false,
): Promise<Readonly<{ photoId?: string }> | SendAnswer> {
  if (photos.draft === null) return {};
  const uploaded = await photos.upload(ticketPhotoPath(eventId), fresh);
  return uploaded.kind === "uploaded" ? { photoId: uploaded.photoId } : uploaded;
}

/**
 * Sends an event card's request: its photo first, then the request with the photo's id. A photo the server calls
 * unusable (swept while the player waited) is uploaded again once and sent under the same key, which the refusal left
 * unused.
 */
async function sendEventTicket(
  props: FormProps,
  photos: PhotoDraftState,
  request: Readonly<{ kind: string; text: string; username: string; key: string }>,
): Promise<SendAnswer> {
  const eventId = props.eventId ?? "";
  const answer = await sendEventTicketOnce(props, request, await photoFor(photos, eventId));
  if (answer.kind !== "refused" || answer.photoUnusable !== true) return answer;
  return sendEventTicketOnce(props, request, await photoFor(photos, eventId, true));
}

async function sendEventTicketOnce(
  props: FormProps,
  request: Readonly<{ kind: string; text: string; username: string; key: string }>,
  photo: Readonly<{ photoId?: string }> | SendAnswer,
): Promise<SendAnswer> {
  if ("kind" in photo) return photo;
  const eventId = props.eventId ?? "";
  return sendTicket(api.session, {
    eventId,
    kind: request.kind as EventTicketKind,
    questId: request.kind === "report_player" ? null : props.questId,
    ...(request.kind === "report_player" ? { reportedUsername: usernameOf(request.username) } : {}),
    text: request.text,
    key: request.key,
    ...photo,
  });
}

/** Sends one card's request with one Idempotency-Key per text and photo, kept after a failure so Retry cannot send twice. */
function useSend(props: FormProps, facts: DeviceFacts | null | undefined, photos: PhotoDraftState) {
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<{ key: string; text: string } | undefined>(undefined);
  const send = async (kind: string, text: string, username: string): Promise<SendAnswer> => {
    // The photo by its picked file, not its upload key: a fresh upload after `photo_unusable` is the same send.
    const signature = `${kind}:${username}:${text}:${photos.draft?.photo.uri ?? ""}`;
    const key = sendKey(last, signature, randomUuid);
    setBusy(true);
    const answer =
      kind === "app_problem" || kind === "suggestion"
        ? await sendPlatformTicket(api.session, { kind, text, device: facts ?? null, key })
        : await sendEventTicket(props, photos, { kind, text, username, key });
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

/** The event card's three choices, as buttons. */
function EventChoices({
  chosen,
  onChoose,
}: Readonly<{ chosen: EventTicketKind | null; onChoose: (kind: EventTicketKind) => void }>) {
  const { t } = useI18n();
  return (
    <>
      {EVENT_CHOICES.map((choice) => (
        <Button
          key={choice.kind}
          label={t(choice.label)}
          kind={chosen === choice.kind ? "primary" : "quiet"}
          onPress={() => onChoose(choice.kind)}
        />
      ))}
    </>
  );
}

/** What the form said after the last send: a line of words, and the server's own message if it brought one. */
function SaidLines({ said }: Readonly<{ said: Said }>) {
  const text = saidText(said);
  return (
    <>
      {text !== null ? <AppText accessibilityRole="alert">{text}</AppText> : null}
      <Problem problem={saidProblem(said)} />
    </>
  );
}

type FieldsProps = Readonly<{
  card: CenterCard;
  kind: string;
  questTitle: string | null;
  facts: DeviceFacts | null | undefined;
  toQuestify: boolean;
  username: string;
  onUsername: (username: string) => void;
  text: string;
  onText: (text: string) => void;
  retrying: boolean;
  disabled: boolean;
  /** An event request's optional photo (T-301b, FR-337); null for a request to Questify. */
  photos: PhotoDraftState | null;
  onSend: () => void;
}>;

/** The form below the choices: the quest line, a report's username, the privacy line, the box and the button. */
function FormFields(props: FieldsProps) {
  const { t } = useI18n();
  const quest = questLineOf(props.questTitle, props.kind);
  const device = deviceNoteOf(props.kind, props.facts);
  return (
    <>
      {quest === null ? null : <AppText muted>{t("help.aboutQuest", { quest })}</AppText>}
      {props.kind === "report_player" ? (
        <>
          <Field
            label={t("help.report.username")}
            value={props.username}
            onChangeText={(value) => props.onUsername(value.slice(0, 31))}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <AppText muted>{t("help.report.anonymous")}</AppText>
        </>
      ) : null}
      <AppText muted>
        {t(props.toQuestify ? "help.private.questify" : "help.private.event")}
      </AppText>
      <TextBox
        label={t(CARD_TITLES[props.card])}
        placeholder={t(placeholderKey(props.kind))}
        text={props.text}
        onChange={props.onText}
      />
      {device === null ? null : (
        <AppText muted>{t("help.device.sentWith", { facts: device })}</AppText>
      )}
      {props.photos === null ? null : (
        <>
          <AppText variant="label">{t("photo.add")}</AppText>
          <PhotoField state={props.photos} disabled={props.disabled} />
        </>
      )}
      {canSendTicket(props.text) ? null : <AppText muted>{t("help.textRequired")}</AppText>}
      <Button
        label={props.retrying ? t("common.retry") : t("help.send")}
        disabled={props.disabled}
        onPress={props.onSend}
      />
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
  const photos = usePhotoDraft();
  const photosOn = useContext(PhotosOn);
  const { busy, retrying, send } = useSend(props, facts, photos);
  const kind = kindOf(props.card, chosen);
  const toQuestify = !cardNeedsEvent(props.card);
  const ready = isReady(kind, text, username, facts);
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
      photos.clear();
      props.onSent();
    }
    setSaid(saidFor(answer, sendLine(answer, toQuestify), t));
  };
  return (
    <>
      {props.card === "event" ? <EventChoices chosen={chosen} onChoose={setChosen} /> : null}
      <SaidLines said={said} />
      {kind === null ? null : (
        <FormFields
          card={props.card}
          kind={kind}
          questTitle={props.questTitle}
          facts={facts}
          toQuestify={toQuestify}
          username={username}
          onUsername={setUsername}
          text={text}
          onText={setText}
          retrying={retrying}
          disabled={busy || photos.uploading || !ready}
          photos={photosOn && props.card === "event" ? photos : null}
          onSend={() => void go()}
        />
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

/** What an opened card shows, as `cardBodyOf` decided: the picker, why sending is off, a wait, or the form. */
function CardBodyView({
  body,
  card,
  events,
  onSent,
  onOff,
}: Readonly<{
  body: CardBody;
  card: CenterCard;
  events: readonly MyEvent[] | undefined;
  onSent: () => void;
  onOff: (why: SendingOff) => void;
}>) {
  const { t } = useI18n();
  switch (body.kind) {
    case "closed":
      return null;
    case "picker":
      return <EventPicker card={card} events={events} />;
    case "off":
      return <AppText accessibilityRole="alert">{t(SENDING_OFF_LINES[body.why])}</AppText>;
    case "loading":
      return <AppText muted>{t("common.loading")}</AppText>;
    case "form":
      return (
        <CardForm
          card={card}
          eventId={body.eventId}
          questId={body.questId}
          questTitle={body.questTitle}
          initialKind={body.initialKind}
          onSent={onSent}
          onOff={onOff}
        />
      );
  }
}

export type TicketCenterProps = Readonly<{
  event: CenterEvent | null;
  /** The player's events, for the picker when there is no fixed event. */
  events?: readonly MyEvent[] | undefined;
  initial?: CenterInitial | undefined;
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
        return (
          <View key={card} style={styles.card} testID={`help-card-${card}`}>
            <Button
              kind={open === card ? "primary" : "quiet"}
              label={t(CARD_TITLES[card])}
              onPress={() => setOpen(open === card ? null : card)}
            />
            <AppText muted>{t(needsEvent ? "help.to.event" : "help.to.questify")}</AppText>
            <CardBodyView
              body={cardBodyOf(card, open, event, initial)}
              card={card}
              events={events}
              onSent={onSent}
              onOff={onOff}
            />
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
