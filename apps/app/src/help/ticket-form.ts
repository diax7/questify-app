import type { EventTicketKind, LocalizedText, MessageKey } from "@questify/shared";
import { canSendTicket, type SendAnswer, type SendingOff } from "#src/event/help.ts";
import { cardNeedsEvent, usernameOf, type CenterCard } from "#src/help/center.ts";
import { deviceLine, type DeviceFacts } from "#src/help/device.ts";

/** The kind a card sends, from its choice; null until the player picks one of the event card's three. */
export const kindOf = (card: CenterCard, chosen: EventTicketKind | null) =>
  card === "report"
    ? "report_player"
    : card === "app"
      ? "app_problem"
      : card === "suggestion"
        ? "suggestion"
        : chosen;

// A Map, so a kind such as "constructor" never reads an inherited property of a plain object.
const PLACEHOLDERS: ReadonlyMap<string, MessageKey> = new Map([
  ["report_player", "help.placeholder.report"],
  ["question", "help.placeholder.question"],
  ["prize", "help.placeholder.problem"],
  ["problem", "help.placeholder.problem"],
  ["app_problem", "help.placeholder.app"],
  ["suggestion", "help.placeholder.suggestion"],
]);

/** The hint inside the request's box, by kind; a kind this app does not know reads as a question. */
export const placeholderKey = (kind: string): MessageKey =>
  PLACEHOLDERS.get(kind) ?? "help.placeholder.question";

/** A report names a member of at least three characters; an app problem waits for the phone's facts. */
export function isReady(
  kind: string | null,
  text: string,
  username: string,
  facts: DeviceFacts | null | undefined,
): boolean {
  return (
    kind !== null &&
    canSendTicket(text) &&
    (kind !== "report_player" || usernameOf(username).length >= 3) &&
    (kind !== "app_problem" || facts !== null)
  );
}

/** What the form says after a send: a line of words, or the server's own message as a problem. */
export type Said = Readonly<{ text: string } | { problem: LocalizedText | null }> | null;

/** `line` is `sendLine`'s line for the answer; `t` is called only when there is one. */
export function saidFor(
  answer: SendAnswer,
  line: MessageKey | null,
  t: (key: MessageKey) => string,
): Said {
  return answer.kind === "refused"
    ? { problem: answer.message }
    : line === null
      ? null
      : { text: t(line) };
}

/** The line of words to show in an alert, if any. */
export const saidText = (said: Said): string | null =>
  said !== null && "text" in said ? said.text : null;

/** The server's message to show as a problem, if any. */
export const saidProblem = (said: Said): LocalizedText | null =>
  said !== null && "problem" in said ? said.problem : null;

/** The quest a request is about, when the form says so: never for a report. */
export const questLineOf = (questTitle: string | null, kind: string): string | null =>
  questTitle === null || kind === "report_player" ? null : questTitle;

/** The phone's facts line under an app problem, once they are read. */
export const deviceNoteOf = (kind: string, facts: DeviceFacts | null | undefined): string | null =>
  kind === "app_problem" && facts !== null && facts !== undefined ? deviceLine(facts) : null;

/** The sending state of the event a center is in: none from the profile; `undefined` while Home has not said. */
export type CenterSending = Readonly<{ id: string; sendingOff: SendingOff | null | undefined }>;

/** What the card for an event shows below its title once opened. */
export type CardBody =
  | Readonly<{ kind: "closed" | "picker" | "loading" }>
  | Readonly<{ kind: "off"; why: SendingOff }>
  | Readonly<{
      kind: "form";
      eventId: string | null;
      questId: string | null;
      questTitle: string | null;
      initialKind: EventTicketKind | null;
    }>;

/** The card the center opened with, and the quest and kind it carries. */
export type CenterInitial = Readonly<{
  card: CenterCard;
  kind: EventTicketKind | null;
  questId: string | null;
  questTitle: string | null;
}>;

/** Decides a card's body: closed, the event picker, the reason sending is off, a wait, or the form. */
export function cardBodyOf(
  card: CenterCard,
  open: CenterCard | null,
  event: CenterSending | null,
  initial: CenterInitial | undefined,
): CardBody {
  if (open !== card) {
    return { kind: "closed" };
  }
  const needsEvent = cardNeedsEvent(card);
  if (needsEvent && event === null) {
    return { kind: "picker" };
  }
  const off = sendingOffIn(needsEvent, event);
  if (off === undefined) {
    return { kind: "loading" };
  }
  if (off !== null) {
    return { kind: "off", why: off };
  }
  const mine = initialFor(card, initial);
  return {
    kind: "form",
    eventId: eventIdOf(needsEvent, event),
    questId: mine.questId,
    questTitle: mine.questTitle,
    initialKind: mine.kind,
  };
}

/** Only an event card is held back by the event's switch; a Questify card is always on. */
const sendingOffIn = (needsEvent: boolean, event: CenterSending | null) =>
  needsEvent ? event?.sendingOff : null;

const eventIdOf = (needsEvent: boolean, event: CenterSending | null): string | null =>
  needsEvent ? (event?.id ?? null) : null;

const NO_INITIAL: CenterInitial = { card: "event", kind: null, questId: null, questTitle: null };

/** The quest and kind the center opened with, for the card they were meant for only. */
const initialFor = (card: CenterCard, initial: CenterInitial | undefined): CenterInitial =>
  initial?.card === card ? initial : NO_INITIAL;
