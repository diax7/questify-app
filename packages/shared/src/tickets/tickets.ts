/** The ticket center's kinds and limits (T-310, T-312, ADR-248, ADR-256, ADR-259); the database enforces each again. */
/** The kinds the event team receives: they need an event (report_player goes to owners and editors only). */
export const EVENT_TICKET_KINDS = ["question", "problem", "prize", "report_player"] as const;
/** The kinds Questify receives: they never carry an event. */
export const PLATFORM_TICKET_KINDS = ["app_problem", "suggestion"] as const;
export const TICKET_KINDS = [...EVENT_TICKET_KINDS, ...PLATFORM_TICKET_KINDS] as const;
export type TicketKind = (typeof TICKET_KINDS)[number];
export type EventTicketKind = (typeof EVENT_TICKET_KINDS)[number];
export type PlatformTicketKind = (typeof PLATFORM_TICKET_KINDS)[number];
/** A request's text, the team's reply and every note: 1 to 1000 characters after cleaning. */
export const TICKET_TEXT_MAX = 1000;
/** Requests one player may have waiting for an answer in one event, and in Questify's queue outside any event. */
export const TICKET_OPEN_LIMIT = 3;
/** An app version or an OS version as the app sends it. */
export const TICKET_DEVICE_FACT = /^[0-9A-Za-z.+-]{1,32}$/;
/** The phone model's longest form. */
export const TICKET_DEVICE_MODEL_MAX = 64;
