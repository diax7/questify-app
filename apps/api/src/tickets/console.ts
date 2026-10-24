import type { TicketKind } from "@questify/shared";
import type { RequestContext } from "#src/db/context";
import {
  answeredOf,
  run,
  type Answered,
  type AnsweredRow,
  type Done,
  type Title,
  type TicketDeps,
} from "#src/tickets/tickets";

/**
 * Questify's queue in the console (T-312, FR-1823, ADR-257, ADR-258): exactly the tickets with queue = 'questify'.
 * Every function of migration 0061 re-reads the admin from the account (`app_admin_id`), so the request flag set here
 * opens nothing on its own; every read is audited by the database, ids only.
 */

const adminSeat = (adminId: string): RequestContext => ({ isAdmin: true, staffUserId: adminId });

/** The device facts of an app problem; null for any other kind. */
export type ConsoleDevice = Readonly<{
  appVersion: string;
  platform: "ios" | "android";
  osVersion: string;
  model: string | null;
}>;

/** Where an escalated ticket comes from; null for an app problem or a suggestion. */
export type ConsoleEventRef = Readonly<{
  organizerId: string;
  organizerName: string | null;
  eventId: string;
  name: Title;
}>;

/** One row of the queue: a preview (120 characters), never the full text; the sender's @username, never an avatar. */
export type ConsoleTicketRow = Readonly<{
  id: string;
  kind: TicketKind;
  preview: string;
  marked: boolean;
  status: "open" | "closed";
  outcome: "answered" | "solved" | null;
  createdAt: Date;
  closedAt: Date | null;
  username: string | null;
  event: ConsoleEventRef | null;
  questTitle: Title | null;
  reportedUsername: string | null;
  escalation: Readonly<{ at: Date; by: string | null }> | null;
  device: ConsoleDevice | null;
}>;

type QueueRow = {
  id: string;
  kind: TicketKind;
  preview: string;
  marked: boolean;
  status: ConsoleTicketRow["status"];
  outcome: ConsoleTicketRow["outcome"];
  created_at: Date;
  closed_at: Date | null;
  username: string | null;
  organizer_id: string | null;
  organizer_name: string | null;
  event_id: string | null;
  event_name_ar: string | null;
  event_name_en: string | null;
  quest_title_ar: string | null;
  quest_title_en: string | null;
  reported_username: string | null;
  escalated_at: Date | null;
  escalated_by: string | null;
  app_version: string | null;
  platform: ConsoleDevice["platform"] | null;
  os_version: string | null;
  device_model: string | null;
};

const eventOf = (row: Omit<QueueRow, "preview">): ConsoleEventRef | null =>
  row.event_id === null || row.organizer_id === null
    ? null
    : {
        organizerId: row.organizer_id,
        organizerName: row.organizer_name,
        eventId: row.event_id,
        name: { ar: row.event_name_ar, en: row.event_name_en },
      };

const deviceOf = (row: Omit<QueueRow, "preview">): ConsoleDevice | null =>
  row.app_version === null || row.platform === null || row.os_version === null
    ? null
    : {
        appVersion: row.app_version,
        platform: row.platform,
        osVersion: row.os_version,
        model: row.device_model,
      };

type Shared = Omit<ConsoleTicketRow, "preview" | "escalation">;

const sharedOf = (row: Omit<QueueRow, "preview">): Shared => ({
  id: row.id,
  kind: row.kind,
  marked: row.marked,
  status: row.status,
  outcome: row.outcome,
  createdAt: row.created_at,
  closedAt: row.closed_at,
  username: row.username,
  event: eventOf(row),
  questTitle:
    row.quest_title_ar === null && row.quest_title_en === null
      ? null
      : { ar: row.quest_title_ar, en: row.quest_title_en },
  reportedUsername: row.reported_username,
  device: deviceOf(row),
});

const rowOf = (row: QueueRow): ConsoleTicketRow => ({
  ...sharedOf(row),
  preview: row.preview,
  escalation: row.escalated_at === null ? null : { at: row.escalated_at, by: row.escalated_by },
});

export type ConsoleCounts = Readonly<{
  open: number;
  closed: number;
  openDirect: number;
  openEscalated: number;
}>;

export type ConsolePage = Readonly<{ tickets: ConsoleTicketRow[]; counts: ConsoleCounts }>;

type CountsRow = { open: number; closed: number; open_direct: number; open_escalated: number };

/** One page of the queue and its counts; the list's read is audited once per event shown (CTO 2). */
export function consoleTickets(
  deps: TicketDeps,
  adminId: string,
  request: Readonly<{
    status: "open" | "closed";
    kind: TicketKind | null;
    source: "direct" | "escalated" | null;
    cursor: string | null;
    limit: number;
    requestId: string;
  }>,
): Promise<Done<ConsolePage>> {
  return run(deps, adminSeat(adminId), async (client) => {
    const { rows } = await client.query<QueueRow>(
      "SELECT * FROM console_tickets($1, $2, $3, $4, $5, $6)",
      [
        request.status,
        request.kind,
        request.source,
        request.cursor,
        request.limit,
        request.requestId,
      ],
    );
    const counted = await client.query<CountsRow>("SELECT * FROM console_ticket_counts()");
    const counts = counted.rows[0] as CountsRow;
    return {
      tickets: rows.map(rowOf),
      counts: {
        open: counts.open,
        closed: counts.closed,
        openDirect: counts.open_direct,
        openEscalated: counts.open_escalated,
      },
    };
  });
}

/** The queue's counts only (the console home's badge): numbers, so not audited. */
export function consoleTicketCounts(
  deps: TicketDeps,
  adminId: string,
): Promise<Done<ConsoleCounts>> {
  return run(deps, adminSeat(adminId), async (client) => {
    const { rows } = await client.query<CountsRow>("SELECT * FROM console_ticket_counts()");
    const counts = rows[0] as CountsRow;
    return {
      open: counts.open,
      closed: counts.closed,
      openDirect: counts.open_direct,
      openEscalated: counts.open_escalated,
    };
  });
}

/** One ticket with the full text, the reply and both notes; who escalated by email, for follow-up. */
export type ConsoleTicket = Shared &
  Readonly<{
    text: string;
    reply: string | null;
    eventStatus: string | null;
    escalation: Readonly<{ at: Date; by: string | null; note: string }> | null;
    returned: Readonly<{ at: Date; note: string }> | null;
    /** The admin who answered (an email); the player and the team only ever see "The Questify team". */
    answeredBy: string | null;
  }>;

type DetailRow = Omit<QueueRow, "preview"> & {
  body: string;
  reply: string | null;
  event_status: string | null;
  escalation_note: string | null;
  returned_at: Date | null;
  return_note: string | null;
  answered_by: string | null;
};

/** One ticket of the queue (HT404 for anything else); the read is audited with the event's ids. */
export function consoleTicket(
  deps: TicketDeps,
  adminId: string,
  request: Readonly<{ ticketId: string; requestId: string }>,
): Promise<Done<ConsoleTicket>> {
  return run(deps, adminSeat(adminId), async (client) => {
    const { rows } = await client.query<DetailRow>("SELECT * FROM console_ticket($1, $2)", [
      request.ticketId,
      request.requestId,
    ]);
    const row = rows[0] as DetailRow;
    return {
      ...sharedOf(row),
      text: row.body,
      reply: row.reply,
      eventStatus: row.event_status,
      escalation:
        row.escalated_at === null
          ? null
          : { at: row.escalated_at, by: row.escalated_by, note: row.escalation_note ?? "" },
      returned:
        row.returned_at === null ? null : { at: row.returned_at, note: row.return_note ?? "" },
      answeredBy: row.answered_by,
    };
  });
}

/** Questify's answer (a reply) or solve (null) of a ticket in its queue; audited, never the text. */
export function adminAnswer(
  deps: TicketDeps,
  adminId: string,
  request: Readonly<{
    ticketId: string;
    reply: string | null;
    idempotencyKey: string;
    requestId: string;
  }>,
): Promise<Done<Answered>> {
  return run(deps, adminSeat(adminId), async (client) => {
    const { rows } = await client.query<AnsweredRow>(
      "SELECT * FROM admin_answer_ticket($1, $2, $3, $4)",
      [request.ticketId, request.reply, request.idempotencyKey, request.requestId],
    );
    return answeredOf(rows);
  });
}

export type Returned = Readonly<{ ticketId: string; queue: "event"; replayed: boolean }>;

/** Questify sends an escalated ticket back to the event team with a note; audited, never the note. */
export function adminReturn(
  deps: TicketDeps,
  adminId: string,
  request: Readonly<{ ticketId: string; note: string; requestId: string }>,
): Promise<Done<Returned>> {
  return run(deps, adminSeat(adminId), async (client) => {
    const { rows } = await client.query<{ ticket_id: string; replayed: boolean }>(
      "SELECT * FROM admin_return_ticket($1, $2, $3)",
      [request.ticketId, request.note, request.requestId],
    );
    const row = rows[0] as { ticket_id: string; replayed: boolean };
    return { ticketId: row.ticket_id, queue: "event", replayed: row.replayed };
  });
}
