/** The help desk's limits (T-310, ADR-248); the database enforces each one again. */
export const TICKET_KINDS = ["question", "problem"] as const;
export type TicketKind = (typeof TICKET_KINDS)[number];
/** A request's text and the team's reply: 1 to 1000 characters after cleaning. */
export const TICKET_TEXT_MAX = 1000;
/** Requests one player may have waiting for an answer in one event. */
export const TICKET_OPEN_LIMIT = 3;
