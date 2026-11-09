import type { LocalizedText, TicketKind } from "@questify/shared";
import type { AuthedResult, Session } from "#src/api/session.ts";
import type { Bilingual } from "#src/i18n/text.ts";

type Requester = Pick<Session, "request">;

/** One row of staff mode's Inbox (`GET /v1/operator/events/{id}/inbox`, T-310, FR-927). */
export type InboxItem = Readonly<{
  kind: "submission" | "ticket";
  id: string;
  createdAt: string;
  /** Null for a ticket about the whole event. */
  questTitle: Bilingual | null;
  /** Null for a deleted account. */
  username: string | null;
  avatar: string;
  preview: string | null;
  /** A word-list hit (FR-1628). */
  marked: boolean;
  ticketKind: TicketKind | null;
}>;

export type Inbox = Readonly<{
  items: readonly InboxItem[];
  nextCursor: string | null;
  abilities: Readonly<{ review: boolean; helpDesk: boolean }>;
}>;

/** The Inbox could not show a list: the operator has neither ability, or it could not be read. */
export type InboxAnswer =
  | Readonly<{ kind: "inbox"; inbox: Inbox }>
  | Readonly<{ kind: "off" }>
  | Readonly<{ kind: "removed" }>
  | Readonly<{ kind: "failed" }>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const nullableText = (value: unknown) => value === null || typeof value === "string";

const isTitle = (value: unknown) =>
  value === null || (isRecord(value) && nullableText(value["ar"]) && nullableText(value["en"]));

const isText = (value: unknown) => typeof value === "string";

const isTicketKind = (value: unknown) =>
  value === "question" || value === "problem" || value === "prize";

/** What each field of a row must be. */
const ITEM_FIELDS: Readonly<Record<keyof InboxItem, (value: unknown) => boolean>> = {
  kind: (value) => value === "submission" || value === "ticket",
  id: isText,
  createdAt: isText,
  questTitle: isTitle,
  username: nullableText,
  avatar: isText,
  preview: nullableText,
  marked: (value) => typeof value === "boolean",
  ticketKind: (value) => value === null || isTicketKind(value),
};

const isItem = (value: unknown): value is InboxItem =>
  isRecord(value) && Object.entries(ITEM_FIELDS).every(([field, ok]) => ok(value[field]));

/** Reads the Inbox; anything malformed reads as a failure, so the screen offers Retry instead of a guess. */
export function inboxOf(body: unknown): Inbox | undefined {
  if (
    !isRecord(body) ||
    !Array.isArray(body["items"]) ||
    !body["items"].every(isItem) ||
    !nullableText(body["nextCursor"]) ||
    !isRecord(body["abilities"]) ||
    typeof body["abilities"]["review"] !== "boolean" ||
    typeof body["abilities"]["helpDesk"] !== "boolean"
  ) {
    return undefined;
  }
  return {
    items: body["items"] as InboxItem[],
    nextCursor: body["nextCursor"] as string | null,
    abilities: { review: body["abilities"]["review"], helpDesk: body["abilities"]["helpDesk"] },
  };
}

export function inboxAnswer(answer: AuthedResult): InboxAnswer {
  if (answer.kind === "error") {
    if (answer.code === "ability_off") {
      return { kind: "off" };
    }
    return answer.code === "not_operator" ? { kind: "removed" } : { kind: "failed" };
  }
  const inbox = answer.kind === "ok" ? inboxOf(answer.body) : undefined;
  return inbox === undefined ? { kind: "failed" } : { kind: "inbox", inbox };
}

const eventPath = (eventId: string) => `/v1/operator/events/${encodeURIComponent(eventId)}`;

export async function fetchInbox(
  session: Requester,
  eventId: string,
  cursor: string | null,
): Promise<InboxAnswer> {
  return inboxAnswer(
    await session.request({
      method: "GET",
      path: `${eventPath(eventId)}/inbox${cursor === null ? "" : `?cursor=${encodeURIComponent(cursor)}`}`,
    }),
  );
}

/**
 * What waits for this operator (T-310's count), for the Inbox badge and Home's "Waiting" line (T-311): `off` for an
 * operator with neither review nor the help desk (OA403, the line hides), `failed` when it could not be read.
 */
export type Waiting =
  | Readonly<{ kind: "count"; total: number }>
  | Readonly<{ kind: "off" }>
  | Readonly<{ kind: "failed" }>;

export async function fetchWaiting(session: Requester, eventId: string): Promise<Waiting> {
  const answer = await session.request({
    method: "GET",
    path: `${eventPath(eventId)}/inbox/count`,
  });
  if (answer.kind === "error" && answer.code === "ability_off") {
    return { kind: "off" };
  }
  const total = answer.kind === "ok" && isRecord(answer.body) ? answer.body["total"] : undefined;
  return typeof total === "number" ? { kind: "count", total } : { kind: "failed" };
}

/** One request as the operator sees it: never who answered. */
export type OperatorTicket = Readonly<{
  id: string;
  kind: TicketKind;
  quest: Readonly<{ id: string; title: Bilingual }> | null;
  username: string | null;
  avatar: string;
  text: string;
  marked: boolean;
  status: "open" | "closed";
  outcome: "answered" | "solved" | null;
  reply: string | null;
  createdAt: string;
}>;

const isTicketQuest = (value: unknown) =>
  value === null || (isRecord(value) && isTitle(value["title"]));

const isTicketStatus = (value: unknown) => value === "open" || value === "closed";

/** What each field of a request must be; `outcome` is not checked, as it never was. */
const TICKET_FIELDS: Readonly<Record<string, (value: unknown) => boolean>> = {
  id: isText,
  kind: isTicketKind,
  quest: isTicketQuest,
  username: nullableText,
  avatar: isText,
  text: isText,
  marked: (value) => typeof value === "boolean",
  status: isTicketStatus,
  reply: nullableText,
  createdAt: isText,
};

const isTicket = (value: unknown): value is OperatorTicket =>
  isRecord(value) && Object.entries(TICKET_FIELDS).every(([field, ok]) => ok(value[field]));

export function ticketOf(body: unknown): OperatorTicket | undefined {
  const ticket = isRecord(body) ? body["ticket"] : undefined;
  return isTicket(ticket) ? ticket : undefined;
}

export async function fetchTicket(
  session: Requester,
  eventId: string,
  ticketId: string,
): Promise<OperatorTicket | undefined> {
  const answer = await session.request({
    method: "GET",
    path: `${eventPath(eventId)}/tickets/${encodeURIComponent(ticketId)}`,
  });
  return answer.kind === "ok" ? ticketOf(answer.body) : undefined;
}

export type AnswerResult =
  | Readonly<{ kind: "done" }>
  /** Someone on the team answered first: back to the list. */
  | Readonly<{ kind: "gone" }>
  /** The request is no longer the operator's (escalated to Questify, T-312) or gone: back to the list. */
  | Readonly<{ kind: "moved" }>
  | Readonly<{ kind: "refused"; message: LocalizedText | null }>
  | Readonly<{ kind: "network" }>
  | Readonly<{ kind: "signed_out" }>;

export function answerResult(answer: AuthedResult): AnswerResult {
  if (answer.kind === "signed_out" || answer.kind === "network") {
    return { kind: answer.kind };
  }
  if (answer.kind === "error") {
    if (answer.code === "not_found") {
      return { kind: "moved" };
    }
    return answer.code === "already_closed"
      ? { kind: "gone" }
      : { kind: "refused", message: answer.message };
  }
  return { kind: "done" };
}

/** Replies (one reply closes it) or, with a null reply, marks it solved; the key is kept for a retry. */
export async function answerTicket(
  session: Requester,
  request: Readonly<{ eventId: string; ticketId: string; reply: string | null; key: string }>,
): Promise<AnswerResult> {
  return answerResult(
    await session.request({
      method: "POST",
      path: `${eventPath(request.eventId)}/tickets/${encodeURIComponent(request.ticketId)}/answer`,
      body: request.reply === null ? {} : { reply: request.reply.trim() },
      headers: { "idempotency-key": request.key },
    }),
  );
}
