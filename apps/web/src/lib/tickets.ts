import { TICKET_TEXT_MAX, type Language, type MessageKey, type TicketKind } from "@questify/shared";
import { translatorFor } from "#src/lib/language.ts";

export type TicketTab = "open" | "with_questify" | "closed";

/** The Help desk page's tabs, in order: what waits first, then what Questify holds (T-312). */
export const TABS: readonly TicketTab[] = ["open", "with_questify", "closed"];

export const TAB_KEYS: Readonly<Record<TicketTab, MessageKey>> = {
  open: "tickets.open",
  with_questify: "tickets.withQuestify",
  closed: "tickets.closed",
};

/** One request of `GET …/events/{id}/tickets` (T-310, T-312). */
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
  status: "open" | "closed";
  outcome: "answered" | "solved" | null;
  reply: string | null;
  /** Questify's answers are `admin` with no name: the team never sees an admin's email. */
  answeredBy: Readonly<{
    kind: "operator" | "staff" | "admin";
    name: string | null;
    deleted: boolean;
  }> | null;
  createdAt: string;
  closedAt: string | null;
  queue: "event" | "questify";
  reported: Readonly<{ enrollmentId: string; username: string | null }> | null;
  escalation: Readonly<{ at: string; note: string; by: string | null }> | null;
  returned: Readonly<{ at: string; note: string }> | null;
}>;

export type TicketPage = Readonly<{
  tickets: TeamTicket[];
  nextCursor: string | null;
  counts: Readonly<{
    open: number;
    withQuestify: number;
    closed: number;
    waitingByKind: Readonly<Partial<Record<TicketKind, number>>>;
  }>;
}>;

/** A tab's count from the page's counts. */
export const tabCount = (counts: TicketPage["counts"] | null, tab: TicketTab): number =>
  counts === null ? 0 : tab === "with_questify" ? counts.withQuestify : counts[tab];

const KIND_KEYS: Readonly<Record<TicketKind, MessageKey>> = {
  question: "help.kind.question",
  problem: "help.kind.problem",
  prize: "tickets.kind.prize",
  report_player: "tickets.kind.report",
  app_problem: "tickets.kind.app",
  suggestion: "tickets.kind.suggestion",
};

export const kindKey = (kind: TicketKind): MessageKey => KIND_KEYS[kind];

/** Where a request stands, in the player's own words for it. */
export function outcomeKey(ticket: Pick<TeamTicket, "status" | "outcome">): MessageKey {
  if (ticket.status === "open") {
    return "help.status.open";
  }
  return ticket.outcome === "solved" ? "help.status.solved" : "help.status.answered";
}

/**
 * "Answered by …" (or "Closed by …" when solved): an operator's @username or a staff email; "Deleted account" once
 * erased; "the Questify team" for Questify's, never a person.
 */
export function answeredByLine(
  ticket: Pick<TeamTicket, "answeredBy" | "outcome">,
  language: Language,
): string | null {
  const by = ticket.answeredBy;
  if (by === null) {
    return null;
  }
  const t = translatorFor(language);
  if (by.kind === "admin") {
    return t(
      ticket.outcome === "solved" ? "tickets.closedByQuestify" : "tickets.answeredByQuestify",
    );
  }
  const name =
    by.deleted || by.name === null
      ? t("tickets.deletedAccount")
      : by.kind === "operator"
        ? `@${by.name}`
        : by.name;
  return t(ticket.outcome === "solved" ? "tickets.closedBy" : "tickets.answeredBy", { name });
}

/** The reported member's line: their @username, or "a deleted account". */
export function reportedLine(
  ticket: Pick<TeamTicket, "reported">,
  language: Language,
): string | null {
  if (ticket.reported === null) {
    return null;
  }
  const t = translatorFor(language);
  return ticket.reported.username === null
    ? t("tickets.reportedDeleted")
    : t("tickets.reported", { username: ticket.reported.username });
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
