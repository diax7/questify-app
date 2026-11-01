import type { EventTicketKind, Inbox, MessageKey } from "@questify/shared";

/** How many requests a card of the Inbox lists before "View more". */
export const INBOX_ROWS = 5;

/** The help-request kinds the Inbox counts, in the order its tiles show them. */
export const INBOX_KINDS: readonly EventTicketKind[] = [
  "question",
  "problem",
  "prize",
  "report_player",
];

const KIND_TITLES: Readonly<Record<EventTicketKind, MessageKey>> = {
  question: "inbox.kind.question",
  problem: "inbox.kind.problem",
  prize: "inbox.kind.prize",
  report_player: "inbox.kind.report",
};

/** The tile's name for a help-request kind. */
export const kindTitleKey = (kind: EventTicketKind): MessageKey => KIND_TITLES[kind];

/** Where the Help desk lists the open requests of a kind, the filtered list a count opens. */
export const helpDeskLink = (eventBase: string, kind: EventTicketKind): string =>
  `${eventBase}/help?status=open&kind=${kind}`;

/** Where the Help desk lists the requests Questify holds after an escalation. */
export const withQuestifyLink = (eventBase: string): string =>
  `${eventBase}/help?status=with_questify`;

/** Everything in the Inbox that waits for the team. */
export function waitingTotal(inbox: Inbox): number {
  const { tickets, withQuestify, joinRequests, submissions, flags } = inbox;
  return (
    tickets.question +
    tickets.problem +
    tickets.prize +
    tickets.report_player +
    withQuestify +
    joinRequests.pending +
    submissions +
    flags
  );
}

/** The first characters of a request's text for a card row: one line, cut at a space, with an ellipsis when cut. */
export function previewOf(text: string, max = 80): string {
  const line = text.replace(/\s+/gu, " ").trim();
  if (line.length <= max) {
    return line;
  }
  const cut = line.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

const WHEN = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/**
 * A request's time as day/month/year and a 24-hour clock with Western digits, the same in both languages: an Arabic
 * locale's own string carries direction marks that scramble the order of its parts in a right-to-left row. Shown in a
 * left-to-right `time`.
 */
export const whenOf = (iso: string): string => WHEN.format(new Date(iso));
