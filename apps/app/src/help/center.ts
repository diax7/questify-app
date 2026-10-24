import type { EventTicketKind, MessageKey, PlatformTicketKind } from "@questify/shared";
import type { Session } from "#src/api/session.ts";
import { sendAnswer, type MyTicket, type SendAnswer } from "#src/event/help.ts";
import type { DeviceFacts } from "#src/help/device.ts";

type Requester = Pick<Session, "request">;

/** The ticket center's four cards (T-312, ADR-256): the first two need an event and go to its team. */
export type CenterCard = "report" | "event" | "app" | "suggestion";

export const CENTER_CARDS: readonly CenterCard[] = ["report", "event", "app", "suggestion"];

/** Whether a card goes to the event team (and needs an event) or to Questify (and never carries one). */
export const cardNeedsEvent = (card: CenterCard): boolean => card === "report" || card === "event";

export const CARD_TITLES: Readonly<Record<CenterCard, MessageKey>> = {
  report: "help.type.report",
  event: "help.type.event",
  app: "help.type.app",
  suggestion: "help.type.suggestion",
};

/** The three choices of "Question or problem at the event" and the kind each one sends (Q-209). */
export const EVENT_CHOICES = [
  { kind: "question", label: "help.event.question" },
  { kind: "prize", label: "help.event.prize" },
  { kind: "problem", label: "help.event.other" },
] as const satisfies readonly Readonly<{ kind: string; label: MessageKey }>[];

/** The line for an answer the form shows in words; null when the answer needs no line or brings its own message. */
export function sendLine(answer: SendAnswer, toQuestify: boolean): MessageKey | null {
  const lines: Partial<Record<SendAnswer["kind"], MessageKey>> = {
    sent: toQuestify ? "help.sentQuestify" : "help.sent",
    too_many_open: toQuestify ? "help.tooManyPlatform" : "help.tooManyOpen",
    too_many: "help.tooMany",
    unknown_player: "help.report.unknown",
    self_report: "help.report.self",
    already_reported: "help.report.already",
    too_many_lookups: "help.report.tooManyLookups",
    network: "join.network",
  };
  return lines[answer.kind] ?? null;
}

/** A username as typed: the @ dropped and spaces trimmed; the server folds case and Arabic letters. */
export const usernameOf = (typed: string): string => typed.trim().replace(/^@/, "").trim();

/** Who signs a reply: the Questify team for its answers, the event team for the rest (never a person). */
export const replyFromKey = (ticket: Pick<MyTicket, "answeredBy">): MessageKey =>
  ticket.answeredBy === "questify" ? "help.replyFromQuestify" : "help.replyFrom";

const KIND_LABELS: Readonly<Record<MyTicket["kind"], MessageKey>> = {
  question: "help.kind.question",
  problem: "help.kind.problem",
  prize: "help.kind.prize",
  report_player: "help.kind.reportPlayer",
  app_problem: "help.kind.appProblem",
  suggestion: "help.kind.suggestion",
};

export const kindLabel = (kind: MyTicket["kind"]): MessageKey => KIND_LABELS[kind];

/**
 * An app problem (with the phone's facts) or a suggestion (with none) to Questify, with no event, under the key kept
 * for retries (rule 5).
 */
export async function sendPlatformTicket(
  session: Requester,
  request: Readonly<{
    kind: PlatformTicketKind;
    text: string;
    device: DeviceFacts | null;
    key: string;
  }>,
): Promise<SendAnswer> {
  return sendAnswer(
    await session.request({
      method: "POST",
      path: "/v1/me/tickets",
      body: {
        kind: request.kind,
        text: request.text,
        ...(request.kind === "app_problem" && request.device !== null
          ? { device: request.device }
          : {}),
      },
      headers: { "idempotency-key": request.key },
    }),
  );
}

const EVENT_KINDS: readonly string[] = ["question", "problem", "prize"];

/**
 * Where the center opens, from the screen's link: a card (`card=report`), or the event card with a kind (the quest
 * sheet's "Report a problem with this quest", the prize screens' "A problem with this prize"); nothing opens otherwise.
 */
export function initialOf(
  params: Readonly<{ card?: string; kind?: string; questId?: string; questTitle?: string }>,
):
  | Readonly<{
      card: CenterCard;
      kind: EventTicketKind | null;
      questId: string | null;
      questTitle: string | null;
    }>
  | undefined {
  const kind = EVENT_KINDS.includes(params.kind ?? "") ? (params.kind as EventTicketKind) : null;
  const card = (CENTER_CARDS as readonly string[]).includes(params.card ?? "")
    ? (params.card as CenterCard)
    : kind === null
      ? null
      : "event";
  if (card === null) {
    return undefined;
  }
  return {
    card,
    kind: card === "event" ? kind : null,
    questId: card === "event" ? (params.questId ?? null) : null,
    questTitle: card === "event" ? (params.questTitle ?? null) : null,
  };
}
