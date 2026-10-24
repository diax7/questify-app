import { TICKET_TEXT_MAX, type Language, type MessageKey, type TicketKind } from "@questify/shared";
import { translatorFor } from "#src/lib/language.ts";

export type TicketTab = "open" | "closed";

/** The Help desk page's tabs, in order: what waits first. */
export const TABS: readonly TicketTab[] = ["open", "closed"];

/** One request of `GET …/events/{id}/tickets` (T-310). */
export type TeamTicket = Readonly<{
  id: string;
  kind: TicketKind;
  quest: Readonly<{ id: string; title: Readonly<{ ar: string | null; en: string | null }> }> | null;
  enrollmentId: string | null;
  /** Null for a deleted account. */
  username: string | null;
  avatar: string;
  text: string;
  marked: boolean;
  status: TicketTab;
  outcome: "answered" | "solved" | null;
  reply: string | null;
  answeredBy: Readonly<{
    kind: "operator" | "staff";
    name: string | null;
    deleted: boolean;
  }> | null;
  createdAt: string;
  closedAt: string | null;
}>;

export type TicketPage = Readonly<{
  tickets: TeamTicket[];
  nextCursor: string | null;
  counts: Readonly<{ open: number; closed: number }>;
}>;

const KIND_KEYS: Readonly<Record<TicketKind, MessageKey>> = {
  question: "help.kind.question",
  problem: "help.kind.problem",
};

export const kindKey = (kind: TicketKind): MessageKey => KIND_KEYS[kind];

/** Where a request stands, in the player's own words for it. */
export function outcomeKey(ticket: Pick<TeamTicket, "status" | "outcome">): MessageKey {
  if (ticket.status === "open") {
    return "help.status.open";
  }
  return ticket.outcome === "solved" ? "help.status.solved" : "help.status.answered";
}

/** "Answered by …": an operator's @username or a staff member's email; "Deleted account" once erased. */
export function answeredByLine(
  ticket: Pick<TeamTicket, "answeredBy">,
  language: Language,
): string | null {
  const by = ticket.answeredBy;
  if (by === null) {
    return null;
  }
  const t = translatorFor(language);
  const name =
    by.deleted || by.name === null
      ? t("tickets.deletedAccount")
      : by.kind === "operator"
        ? `@${by.name}`
        : by.name;
  return t("tickets.answeredBy", { name });
}

/** A reply of 1 to 1000 characters after trimming, as the server checks. */
export const canReply = (reply: string): boolean => {
  const length = reply.trim().length;
  return length >= 1 && length <= TICKET_TEXT_MAX;
};

/** The page's query: one tab, one kind or all, from a cursor. */
export function ticketQuery(
  tab: TicketTab,
  kind: TicketKind | null,
  cursor: string | null,
): string {
  const parts = [`status=${tab}`];
  if (kind !== null) {
    parts.push(`kind=${kind}`);
  }
  if (cursor !== null) {
    parts.push(`cursor=${encodeURIComponent(cursor)}`);
  }
  return `?${parts.join("&")}`;
}
