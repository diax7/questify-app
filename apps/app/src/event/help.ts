import {
  TICKET_KINDS,
  TICKET_TEXT_MAX,
  type EventTicketKind,
  type LocalizedText,
  type MessageKey,
  type TicketKind,
} from "@questify/shared";
import type { AuthedResult, Session } from "#src/api/session.ts";
import type { Bilingual } from "#src/i18n/text.ts";

type Requester = Pick<Session, "request">;

/**
 * One of the player's own requests (`GET …/tickets/mine` or `GET /v1/me/tickets`, T-310, T-312): never who answered,
 * only which team; never a note.
 */
export type MyTicket = Readonly<{
  id: string;
  /** In the profile's list of every event's requests; null there for an app problem or a suggestion. */
  event: Readonly<{ id: string; name: Bilingual }> | null;
  kind: TicketKind;
  quest: Readonly<{ id: string; title: Bilingual }> | null;
  text: string;
  status: "open" | "closed";
  outcome: "answered" | "solved" | null;
  /** The reply, signed "The event team" or "The Questify team" by `answeredBy`. */
  reply: string | null;
  createdAt: string;
  /** An answer the player has not seen yet: a gold dot. */
  unread: boolean;
  /** Open and waiting with the Questify team. */
  withQuestify: boolean;
  answeredBy: "event" | "questify" | null;
  /** On the player's own report: the username they reported; null once that account is deleted. */
  reportedUsername: string | null;
}>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isText = (value: unknown): value is Bilingual =>
  isRecord(value) &&
  (value["ar"] === null || typeof value["ar"] === "string") &&
  (value["en"] === null || typeof value["en"] === "string");

const isNamed = (value: unknown, field: "name" | "title") =>
  value === null ||
  value === undefined ||
  (isRecord(value) && typeof value["id"] === "string" && isText(value[field]));

const isTicket = (value: unknown): value is Record<string, unknown> =>
  isRecord(value) &&
  typeof value["id"] === "string" &&
  (TICKET_KINDS as readonly unknown[]).includes(value["kind"]) &&
  isNamed(value["quest"], "title") &&
  isNamed(value["event"], "name") &&
  typeof value["text"] === "string" &&
  (value["status"] === "open" || value["status"] === "closed") &&
  (value["outcome"] === null || value["outcome"] === "answered" || value["outcome"] === "solved") &&
  (value["reply"] === null || typeof value["reply"] === "string") &&
  typeof value["createdAt"] === "string" &&
  typeof value["unread"] === "boolean" &&
  (value["withQuestify"] === undefined || typeof value["withQuestify"] === "boolean") &&
  (value["answeredBy"] === undefined ||
    value["answeredBy"] === null ||
    value["answeredBy"] === "event" ||
    value["answeredBy"] === "questify") &&
  (value["reportedUsername"] === undefined ||
    value["reportedUsername"] === null ||
    typeof value["reportedUsername"] === "string");

/** Reads a list of requests; anything malformed reads as nothing, so the screen shows a load failure, not a guess. */
export function ticketsOf(body: unknown): MyTicket[] | undefined {
  if (!isRecord(body) || !Array.isArray(body["tickets"]) || !body["tickets"].every(isTicket)) {
    return undefined;
  }
  return (body["tickets"] as Record<string, unknown>[]).map((ticket) => ({
    id: ticket["id"] as string,
    event: (ticket["event"] ?? null) as MyTicket["event"],
    kind: ticket["kind"] as TicketKind,
    quest: (ticket["quest"] ?? null) as MyTicket["quest"],
    text: ticket["text"] as string,
    status: ticket["status"] as MyTicket["status"],
    outcome: ticket["outcome"] as MyTicket["outcome"],
    reply: ticket["reply"] as string | null,
    createdAt: ticket["createdAt"] as string,
    unread: ticket["unread"] as boolean,
    withQuestify: ticket["withQuestify"] === true,
    answeredBy: (ticket["answeredBy"] ?? null) as MyTicket["answeredBy"],
    reportedUsername: (ticket["reportedUsername"] ?? null) as string | null,
  }));
}

/** The words for where a request stands. */
export function ticketStatusKey(
  ticket: Pick<MyTicket, "status" | "outcome"> & Partial<Pick<MyTicket, "withQuestify">>,
): MessageKey {
  if (ticket.status === "open") {
    return ticket.withQuestify === true ? "help.status.withQuestify" : "help.status.open";
  }
  return ticket.outcome === "solved" ? "help.status.solved" : "help.status.answered";
}

/** Why the form is hidden while Your requests still shows; null when the player may send. */
export type SendingOff = "feature_off" | "not_member" | "sending_closed";

/** Whether sending is off, from a refusal's code; anything else leaves the form as it is. */
export function sendingOffOf(code: string): SendingOff | null {
  return code === "feature_off" || code === "not_member" || code === "sending_closed" ? code : null;
}

export const SENDING_OFF_LINES: Readonly<Record<SendingOff, MessageKey>> = {
  feature_off: "help.off",
  not_member: "help.notMember",
  sending_closed: "help.sendClosed",
};

const SENDING_DAYS_AFTER_END = 30;

/**
 * Whether sending is off before trying, from what Home last said (ADR-248): the switch, an active membership (`null`
 * when Home answered 403: left, removed or banned), and the event scheduled, live or ended under 30 days ago. The
 * server decides again on every send.
 */
export function sendingOffFor(
  state: Readonly<{
    helpOn: boolean;
    standing: "active" | "pending" | "declined" | null;
    statusNow: string;
    endsAt: string | null;
  }>,
  now: number,
): SendingOff | null {
  if (!state.helpOn) {
    return "feature_off";
  }
  if (state.standing !== "active") {
    return "not_member";
  }
  const closedAt =
    state.endsAt === null
      ? Number.POSITIVE_INFINITY
      : Date.parse(state.endsAt) + SENDING_DAYS_AFTER_END * 24 * 60 * 60 * 1000;
  return ["scheduled", "live", "ended"].includes(state.statusNow) && now < closedAt
    ? null
    : "sending_closed";
}

/** The answer to a send, in the words the screen needs. */
export type SendAnswer =
  | Readonly<{ kind: "sent" }>
  /** Sending is off for this player: the form hides, Your requests stays. */
  | Readonly<{ kind: "off"; why: SendingOff }>
  | Readonly<{ kind: "too_many_open" }>
  | Readonly<{ kind: "too_many" }>
  /** A report's refusals (T-312): no such member here, oneself, reported already, too many names tried. */
  | Readonly<{ kind: "unknown_player" | "self_report" | "already_reported" | "too_many_lookups" }>
  | Readonly<{ kind: "refused"; message: LocalizedText | null }>
  | Readonly<{ kind: "network" }>
  | Readonly<{ kind: "signed_out" }>;

export function sendAnswer(answer: AuthedResult): SendAnswer {
  if (answer.kind === "signed_out" || answer.kind === "network") {
    return { kind: answer.kind };
  }
  if (answer.kind === "error") {
    const off = sendingOffOf(answer.code);
    if (off !== null) {
      return { kind: "off", why: off };
    }
    if (
      answer.code === "too_many_open" ||
      answer.code === "unknown_player" ||
      answer.code === "self_report" ||
      answer.code === "already_reported" ||
      answer.code === "too_many_lookups"
    ) {
      return { kind: answer.code };
    }
    return answer.code === "too_many_tickets"
      ? { kind: "too_many" }
      : { kind: "refused", message: answer.message };
  }
  return { kind: "sent" };
}

/** Bounds the box as the server does (1000 characters after trimming); the server cleans the rest. */
export const canSendTicket = (text: string): boolean => {
  const length = text.trim().length;
  return length >= 1 && length <= TICKET_TEXT_MAX;
};

const eventPath = (eventId: string) => `/v1/events/${encodeURIComponent(eventId)}`;

/** The player's requests in one event, or (null) in every event for the profile. */
export async function fetchMyTickets(
  session: Requester,
  eventId: string | null,
): Promise<MyTicket[] | undefined> {
  const answer = await session.request({
    method: "GET",
    path: eventId === null ? "/v1/me/tickets" : `${eventPath(eventId)}/tickets/mine`,
  });
  return answer.kind === "ok" ? ticketsOf(answer.body) : undefined;
}

/** Sends a request with the key kept for retries (rule 5): the same key after a dropped connection. */
export async function sendTicket(
  session: Requester,
  request: Readonly<{
    eventId: string;
    kind: EventTicketKind;
    questId: string | null;
    /** Only for a report: the member's @username, without the @. */
    reportedUsername?: string;
    text: string;
    key: string;
  }>,
): Promise<SendAnswer> {
  return sendAnswer(
    await session.request({
      method: "POST",
      path: `${eventPath(request.eventId)}/tickets`,
      body: {
        kind: request.kind,
        text: request.text,
        ...(request.questId === null ? {} : { questId: request.questId }),
        ...(request.reportedUsername === undefined
          ? {}
          : { reportedUsername: request.reportedUsername }),
      },
      headers: { "idempotency-key": request.key },
    }),
  );
}

/** Marks the answers on screen as seen (at most 50), in one event or (null) any; a failure is retried next time. */
export async function markSeen(
  session: Requester,
  eventId: string | null,
  tickets: readonly MyTicket[],
): Promise<void> {
  const ids = tickets
    .filter((ticket) => ticket.unread)
    .map((ticket) => ticket.id)
    .slice(0, 50);
  if (ids.length === 0) {
    return;
  }
  await session.request({
    method: "POST",
    path: eventId === null ? "/v1/me/tickets/seen" : `${eventPath(eventId)}/tickets/seen`,
    body: { ids },
  });
}
