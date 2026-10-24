import type { TicketKind } from "@questify/shared";

type Text = Readonly<{ ar: string | null; en: string | null }>;

export type ConsoleTab = "open" | "closed";
export type ConsoleSource = "direct" | "escalated";

/** An app problem's phone facts (T-312): no identifier, never the phone's own name. */
export type ConsoleDevice = Readonly<{
  appVersion: string;
  platform: "ios" | "android";
  osVersion: string;
  model: string | null;
}>;

/** One row of Questify's queue (`GET /v1/admin/tickets`): a preview, never the full text, and no avatar. */
export type ConsoleTicketRow = Readonly<{
  id: string;
  kind: TicketKind;
  preview: string;
  marked: boolean;
  status: ConsoleTab;
  outcome: "answered" | "solved" | null;
  createdAt: string;
  closedAt: string | null;
  username: string | null;
  event: Readonly<{
    organizerId: string;
    organizerName: string | null;
    eventId: string;
    name: Text;
  }> | null;
  questTitle: Text | null;
  reportedUsername: string | null;
  escalation: Readonly<{ at: string; by: string | null }> | null;
  device: ConsoleDevice | null;
}>;

export type ConsoleCounts = Readonly<{
  open: number;
  closed: number;
  openDirect: number;
  openEscalated: number;
}>;

export type ConsoleTicketPage = Readonly<{
  tickets: ConsoleTicketRow[];
  nextCursor: string | null;
  counts: ConsoleCounts;
}>;

/** One ticket with its full text, the reply and the notes (`GET /v1/admin/tickets/{id}`). */
export type ConsoleTicketDetail = Omit<ConsoleTicketRow, "preview" | "escalation"> &
  Readonly<{
    text: string;
    reply: string | null;
    eventStatus: string | null;
    escalation: Readonly<{ at: string; by: string | null; note: string }> | null;
    returned: Readonly<{ at: string; note: string }> | null;
    answeredBy: string | null;
  }>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isCounts = (value: unknown): value is ConsoleCounts =>
  isRecord(value) &&
  ["open", "closed", "openDirect", "openEscalated"].every(
    (name) => typeof value[name] === "number",
  );

/** The queue's page; undefined when the answer is not the expected shape. */
export function readConsoleTickets(value: unknown): ConsoleTicketPage | undefined {
  if (!isRecord(value) || !Array.isArray(value["tickets"]) || !isCounts(value["counts"])) {
    return undefined;
  }
  const valid = value["tickets"].every(
    (row) =>
      isRecord(row) &&
      typeof row["id"] === "string" &&
      typeof row["kind"] === "string" &&
      typeof row["preview"] === "string" &&
      (row["status"] === "open" || row["status"] === "closed") &&
      typeof row["createdAt"] === "string",
  );
  return valid ? (value as ConsoleTicketPage) : undefined;
}

/** The counts alone (the console home's link); undefined when unreadable. */
export function readConsoleCounts(value: unknown): ConsoleCounts | undefined {
  const counts = isRecord(value) ? value["counts"] : undefined;
  return isCounts(counts) ? counts : undefined;
}

/** One ticket; undefined when the answer is not the expected shape. */
export function readConsoleTicket(value: unknown): ConsoleTicketDetail | undefined {
  const ticket = isRecord(value) ? value["ticket"] : undefined;
  const valid =
    isRecord(ticket) &&
    typeof ticket["id"] === "string" &&
    typeof ticket["text"] === "string" &&
    (ticket["status"] === "open" || ticket["status"] === "closed");
  return valid ? (ticket as ConsoleTicketDetail) : undefined;
}

/** The queue's query: one tab, a kind, a source, from a cursor. */
export function consoleTicketQuery(
  tab: ConsoleTab,
  kind: TicketKind | null,
  source: ConsoleSource | null,
  cursor: string | null,
): string {
  const parts = [`status=${tab}`];
  if (kind !== null) {
    parts.push(`kind=${kind}`);
  }
  if (source !== null) {
    parts.push(`source=${source}`);
  }
  if (cursor !== null) {
    parts.push(`cursor=${encodeURIComponent(cursor)}`);
  }
  return `?${parts.join("&")}`;
}

/** "Questify 1.4.0 · iPhone 15 Pro · iOS 18.1": the phone facts in one line. */
export function deviceLine(device: ConsoleDevice): string {
  const system = `${device.platform === "ios" ? "iOS" : "Android"} ${device.osVersion}`;
  return [`Questify ${device.appVersion}`, device.model, system]
    .filter((part) => part !== null)
    .join(" · ");
}

const TICKET_ID = /^[1-9][0-9]{0,17}$/;

/** Whether a path segment can name a ticket; anything else must never reach an API path in the admin's browser. */
export const isTicketId = (value: string): boolean => TICKET_ID.test(value);
