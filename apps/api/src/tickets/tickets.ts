import type { EventTicketKind, PlatformTicketKind, TicketKind } from "@questify/shared";
import type { Pool, PoolClient } from "pg";
import { withConnection } from "#src/db/connection";
import { withRequestContext, type RequestContext } from "#src/db/context";
import type { OrganizerContext } from "#src/organizers/store";

export type TicketDeps = Readonly<{ pool: Pool }>;

/** Why a ticket was refused; each maps to one HTTP answer in the routes (API.md, Help desk). */
export type TicketRefusal =
  | Readonly<{ kind: "not_found" }>
  | Readonly<{ kind: "not_member" }>
  | Readonly<{ kind: "feature_off" }>
  | Readonly<{ kind: "sending_closed" }>
  | Readonly<{ kind: "unknown_quest" }>
  | Readonly<{ kind: "invalid_kind" }>
  | Readonly<{ kind: "invalid_text"; problem: string }>
  | Readonly<{ kind: "too_many_open" }>
  | Readonly<{ kind: "too_many_tickets"; retryAfterSeconds: number }>
  | Readonly<{ kind: "key_reused" }>
  | Readonly<{ kind: "already_closed" }>
  | Readonly<{ kind: "event_closed" }>
  | Readonly<{ kind: "self_answer" }>
  | Readonly<{ kind: "outside_quests" }>
  | Readonly<{ kind: "not_operator" }>
  | Readonly<{ kind: "ability_off" }>
  | Readonly<{ kind: "unknown_player" }>
  | Readonly<{ kind: "self_report" }>
  | Readonly<{ kind: "already_reported" }>
  | Readonly<{ kind: "username_required" }>
  | Readonly<{ kind: "invalid_device"; field: string }>
  | Readonly<{ kind: "not_open" }>
  | Readonly<{ kind: "moved" }>
  | Readonly<{ kind: "not_escalated" }>;

export type Done<T> = Readonly<{ kind: "done"; value: T }> | TicketRefusal;

const FORBIDDEN: Readonly<Record<string, TicketRefusal>> = {
  not_member: { kind: "not_member" },
  feature_off: { kind: "feature_off" },
  sending_closed: { kind: "sending_closed" },
  self_answer: { kind: "self_answer" },
  outside_quests: { kind: "outside_quests" },
};

const CONFLICTS: Readonly<Record<string, TicketRefusal>> = {
  too_many_open: { kind: "too_many_open" },
  event_closed: { kind: "event_closed" },
  already_reported: { kind: "already_reported" },
  not_open: { kind: "not_open" },
  moved: { kind: "moved" },
  not_escalated: { kind: "not_escalated" },
};

/** The SQLSTATEs of migrations 0059 and 0061's doors; the DETAIL picks the answer where one code has several. */
const REFUSALS: Readonly<Record<string, (detail: string) => TicketRefusal | undefined>> = {
  HT404: () => ({ kind: "not_found" }),
  AN404: () => ({ kind: "not_found" }),
  HQ404: () => ({ kind: "unknown_quest" }),
  HK422: () => ({ kind: "invalid_kind" }),
  // A quest on a report, or a username on another kind: the routes' own checks send neither.
  HQ422: () => ({ kind: "invalid_kind" }),
  HR422: (detail) =>
    detail === "username_required" ? { kind: "username_required" } : { kind: "invalid_kind" },
  HR404: () => ({ kind: "unknown_player" }),
  HR403: () => ({ kind: "self_report" }),
  HD422: (detail) => ({ kind: "invalid_device", field: detail }),
  QK422: () => ({ kind: "key_reused" }),
  SV422: (detail) => ({ kind: "invalid_text", problem: detail }),
  HT403: (detail) => FORBIDDEN[detail],
  HT409: (detail) => CONFLICTS[detail] ?? { kind: "already_closed" },
  HT429: (detail) => ({ kind: "too_many_tickets", retryAfterSeconds: Math.max(1, Number(detail)) }),
  OP403: () => ({ kind: "not_operator" }),
  OA403: () => ({ kind: "ability_off" }),
};

/** Runs one call in `context`; a refusal the database raises becomes its result, anything else is thrown. */
export async function run<T>(
  deps: TicketDeps,
  context: RequestContext,
  work: (client: PoolClient) => Promise<T>,
): Promise<Done<T>> {
  try {
    const value = await withConnection(deps.pool, (client) =>
      withRequestContext(client, context, () => work(client)),
    );
    return { kind: "done", value };
  } catch (error) {
    const pg = error as { code?: string; detail?: string; constraint?: string };
    // A backstop: answer_core serializes one answerer's key, so its unique index should never be what refuses it.
    const keyIndex =
      pg.code === "23505" && pg.constraint?.startsWith("ticket_answer_key_") === true;
    // A backstop too: open_ticket refuses a second open report under the enrollment lock first.
    const reportIndex = pg.code === "23505" && pg.constraint === "ticket_open_report_key";
    const refusal = keyIndex
      ? { kind: "key_reused" as const }
      : reportIndex
        ? { kind: "already_reported" as const }
        : REFUSALS[String(pg.code)]?.(pg.detail ?? "");
    if (refusal === undefined) {
      throw error;
    }
    return refusal;
  }
}

const staffSeat = (context: OrganizerContext): RequestContext => ({
  organizerId: context.organizerId,
  staffUserId: context.staffUserId,
});

export type Title = Readonly<{ ar: string | null; en: string | null }>;
export const titleOf = (ar: string | null, en: string | null, id: string | null): Title | null =>
  id === null ? null : { ar, en };

// ---------------------------------------------------------------- the player's side

export type Opened = Readonly<{
  ticketId: string;
  status: "open" | "closed";
  createdAt: Date;
  /** A word-list hit (FR-1628): for the log's count only, never shown to the player. */
  marked: boolean;
  replayed: boolean;
}>;

type OpenedRow = {
  ticket_id: string;
  status: Opened["status"];
  created_at: Date;
  marked: boolean;
  replayed: boolean;
};

const openedOf = (rows: readonly OpenedRow[]): Opened => {
  const row = rows[0] as OpenedRow;
  return {
    ticketId: row.ticket_id,
    status: row.status,
    createdAt: row.created_at,
    marked: row.marked,
    replayed: row.replayed,
  };
};

/**
 * The player's ticket to the event team (FR-337, FR-1822): a question, a problem, a prize problem or a report of
 * another member by username; `open_ticket` checks every rule (migrations 0059, 0061).
 */
export function openTicket(
  deps: TicketDeps,
  request: Readonly<{
    playerId: string;
    eventId: string;
    kind: EventTicketKind;
    questId: string | null;
    reportedUsername: string | null;
    text: string;
    idempotencyKey: string;
  }>,
): Promise<Done<Opened>> {
  return run(deps, { playerId: request.playerId }, async (client) => {
    const { rows } = await client.query<OpenedRow>(
      "SELECT * FROM open_ticket($1, $2, $3, $4, $5, $6)",
      [
        request.eventId,
        request.kind,
        request.questId,
        request.reportedUsername,
        request.text,
        request.idempotencyKey,
      ],
    );
    return openedOf(rows);
  });
}

/** The phone's facts sent with an app problem; the model is null from a build without `expo-device`. */
export type DeviceFacts = Readonly<{
  appVersion: string;
  platform: "ios" | "android";
  osVersion: string;
  model: string | null;
}>;

/** The player's app problem or suggestion to Questify, with no event (FR-1822); `open_platform_ticket` (0061). */
export function openPlatformTicket(
  deps: TicketDeps,
  request: Readonly<{
    playerId: string;
    kind: PlatformTicketKind;
    text: string;
    device: DeviceFacts | null;
    idempotencyKey: string;
  }>,
): Promise<Done<Opened>> {
  return run(deps, { playerId: request.playerId }, async (client) => {
    const { rows } = await client.query<OpenedRow>(
      "SELECT * FROM open_platform_ticket($1, $2, $3, $4, $5, $6, $7)",
      [
        request.kind,
        request.text,
        request.device?.appVersion ?? null,
        request.device?.platform ?? null,
        request.device?.osVersion ?? null,
        request.device?.model ?? null,
        request.idempotencyKey,
      ],
    );
    return openedOf(rows);
  });
}

/** One of the player's own tickets: never who answered, only which team (ADR-257), never a note. */
export type OwnTicket = Readonly<{
  id: string;
  event: Readonly<{ id: string; name: Title }> | null;
  kind: TicketKind;
  quest: Readonly<{ id: string; title: Title }> | null;
  text: string;
  status: "open" | "closed";
  outcome: "answered" | "solved" | null;
  reply: string | null;
  closedAt: Date | null;
  createdAt: Date;
  unread: boolean;
  /** Open and waiting with the Questify team (escalated, or an app problem or suggestion). */
  withQuestify: boolean;
  answeredBy: "event" | "questify" | null;
  /** The username the sender reported, on their own report; null once that account is deleted. */
  reportedUsername: string | null;
}>;

type OwnRow = {
  id: string;
  event_id: string | null;
  event_name_ar: string | null;
  event_name_en: string | null;
  kind: TicketKind;
  quest_id: string | null;
  quest_title_ar: string | null;
  quest_title_en: string | null;
  body: string;
  status: OwnTicket["status"];
  outcome: OwnTicket["outcome"];
  reply: string | null;
  closed_at: Date | null;
  created_at: Date;
  unread: boolean;
  with_questify: boolean;
  answered_by_team: OwnTicket["answeredBy"];
  reported_username: string | null;
};

const ownOf = (row: OwnRow): OwnTicket => ({
  id: row.id,
  event:
    row.event_id === null
      ? null
      : { id: row.event_id, name: { ar: row.event_name_ar, en: row.event_name_en } },
  kind: row.kind,
  quest:
    row.quest_id === null
      ? null
      : { id: row.quest_id, title: { ar: row.quest_title_ar, en: row.quest_title_en } },
  text: row.body,
  status: row.status,
  outcome: row.outcome,
  reply: row.reply,
  closedAt: row.closed_at,
  createdAt: row.created_at,
  unread: row.unread,
  withQuestify: row.with_questify,
  answeredBy: row.answered_by_team,
  reportedUsername: row.reported_username,
});

/** The player's own tickets in one event (at most 50), or in every event with null (at most 100). */
export function ownTickets(
  deps: TicketDeps,
  playerId: string,
  eventId: string | null,
): Promise<OwnTicket[]> {
  return withConnection(deps.pool, (client) =>
    withRequestContext(client, { playerId }, async () => {
      const { rows } = await client.query<OwnRow>("SELECT * FROM own_tickets($1)", [eventId]);
      return rows.map(ownOf);
    }),
  );
}

/** How many of the calling player's answers they have not seen: in an event (Home's strip) or, null, anywhere. */
export async function readUnreadTickets(
  client: PoolClient,
  eventId: string | null,
): Promise<number> {
  const { rows } = await client.query<{ unread: number }>(
    "SELECT own_unread_tickets($1) AS unread",
    [eventId],
  );
  return rows[0]?.unread ?? 0;
}

/** Marks the player's own answers as seen, in one event or (null) any; answers how many were newly marked. */
export function markTicketsSeen(
  deps: TicketDeps,
  playerId: string,
  request: Readonly<{ eventId: string | null; ids: readonly string[] }>,
): Promise<number> {
  return withConnection(deps.pool, (client) =>
    withRequestContext(client, { playerId }, async () => {
      const { rows } = await client.query<{ marked: number }>(
        "SELECT mark_tickets_seen($1, $2::bigint[]) AS marked",
        [request.eventId, request.ids],
      );
      return rows[0]?.marked ?? 0;
    }),
  );
}

// ---------------------------------------------------------------- answering

export type Answered = Readonly<{
  ticketId: string;
  outcome: "answered" | "solved";
  replayed: boolean;
}>;

export type AnsweredRow = { ticket_id: string; outcome: Answered["outcome"]; replayed: boolean };

export const answeredOf = (rows: readonly AnsweredRow[]): Answered => {
  const row = rows[0] as AnsweredRow;
  return { ticketId: row.ticket_id, outcome: row.outcome, replayed: row.replayed };
};

export type AnswerRequest = Readonly<{
  eventId: string;
  ticketId: string;
  /** Null closes the ticket as solved with no reply. */
  reply: string | null;
  idempotencyKey: string;
}>;

/** An owner's or editor's answer from the dashboard (FR-338). Audited by the database, without the text. */
export function staffAnswer(
  deps: TicketDeps,
  context: OrganizerContext,
  request: AnswerRequest & Readonly<{ requestId: string }>,
): Promise<Done<Answered>> {
  return run(deps, staffSeat(context), async (client) => {
    const { rows } = await client.query<AnsweredRow>(
      "SELECT * FROM staff_answer_ticket($1, $2, $3, $4, $5)",
      [request.eventId, request.ticketId, request.reply, request.idempotencyKey, request.requestId],
    );
    return answeredOf(rows);
  });
}

/** An operator's answer from staff mode (FR-338, FR-927), with the help-desk ability. */
export function operatorAnswer(
  deps: TicketDeps,
  playerId: string,
  request: AnswerRequest,
): Promise<Done<Answered>> {
  return run(deps, { playerId }, async (client) => {
    const { rows } = await client.query<AnsweredRow>(
      "SELECT * FROM operator_answer_ticket($1, $2, $3, $4)",
      [request.eventId, request.ticketId, request.reply, request.idempotencyKey],
    );
    return answeredOf(rows);
  });
}

// ---------------------------------------------------------------- the team's reads

/** A ticket as the team sees it: the player's @username and avatar, never a contact or a name. */
export type TeamTicket = Readonly<{
  id: string;
  kind: TicketKind;
  quest: Readonly<{ id: string; title: Title }> | null;
  enrollmentId: string | null;
  /** Null for a deleted account. */
  username: string | null;
  avatar: string;
  text: string;
  marked: boolean;
  status: "open" | "closed";
  outcome: "answered" | "solved" | null;
  reply: string | null;
  /**
   * Who answered, for accountability: the operator's @username or the staff member's email; for Questify, `admin`
   * with no name (the team never sees an admin's email).
   */
  answeredBy: Readonly<{
    kind: "operator" | "staff" | "admin";
    name: string | null;
    deleted: boolean;
  }> | null;
  createdAt: Date;
  closedAt: Date | null;
  queue: "event" | "questify";
  /** A report's member: the @username is null once that account is deleted. */
  reported: Readonly<{ enrollmentId: string; username: string | null }> | null;
  /** The latest escalation: what the team wrote for Questify and who sent it. */
  escalation: Readonly<{ at: Date; note: string; by: string | null }> | null;
  /** Questify's latest send-back and its note for the team. */
  returned: Readonly<{ at: Date; note: string }> | null;
}>;

type TeamRow = {
  id: string;
  kind: TicketKind;
  quest_id: string | null;
  quest_title_ar: string | null;
  quest_title_en: string | null;
  enrollment_id: string | null;
  username: string | null;
  avatar: string;
  body: string;
  marked: boolean;
  status: TeamTicket["status"];
  outcome: TeamTicket["outcome"];
  reply: string | null;
  answered_by: "operator" | "staff" | "admin" | null;
  answerer: string | null;
  answerer_deleted: boolean;
  created_at: Date;
  closed_at: Date | null;
  queue: TeamTicket["queue"];
  reported_enrollment_id: string | null;
  reported_username: string | null;
  escalated_at: Date | null;
  escalation_note: string | null;
  escalated_by: string | null;
  returned_at: Date | null;
  return_note: string | null;
};

const escalationOf = (row: TeamRow): TeamTicket["escalation"] =>
  row.escalated_at === null
    ? null
    : { at: row.escalated_at, note: row.escalation_note ?? "", by: row.escalated_by };

const teamOf = (row: TeamRow): TeamTicket => ({
  id: row.id,
  kind: row.kind,
  quest:
    row.quest_id === null
      ? null
      : { id: row.quest_id, title: { ar: row.quest_title_ar, en: row.quest_title_en } },
  enrollmentId: row.enrollment_id,
  username: row.username,
  avatar: row.avatar,
  text: row.body,
  marked: row.marked,
  status: row.status,
  outcome: row.outcome,
  reply: row.reply,
  answeredBy:
    row.answered_by === null
      ? null
      : { kind: row.answered_by, name: row.answerer, deleted: row.answerer_deleted },
  createdAt: row.created_at,
  closedAt: row.closed_at,
  queue: row.queue,
  reported:
    row.reported_enrollment_id === null
      ? null
      : { enrollmentId: row.reported_enrollment_id, username: row.reported_username },
  escalation: escalationOf(row),
  returned: row.returned_at === null ? null : { at: row.returned_at, note: row.return_note ?? "" },
});

export type TeamCounts = Readonly<{
  open: number;
  withQuestify: number;
  closed: number;
  /** Tickets waiting (open, in either queue) by kind; a kind with none is absent. */
  waitingByKind: Readonly<Partial<Record<TicketKind, number>>>;
}>;

export type TeamPage = Readonly<{ tickets: TeamTicket[]; counts: TeamCounts }>;

export type TeamTab = "open" | "with_questify" | "closed";

type CountsRow = {
  open: number;
  with_questify: number;
  closed: number;
  waiting_by_kind: TeamCounts["waitingByKind"];
};

/** The dashboard's Help desk page (FR-339, FR-1823): one tab, one kind or all, one page, and every tab's counts. */
export function staffTickets(
  deps: TicketDeps,
  context: OrganizerContext,
  request: Readonly<{
    eventId: string;
    status: TeamTab;
    kind: TicketKind | null;
    cursor: string | null;
    limit: number;
  }>,
): Promise<Done<TeamPage>> {
  return run(deps, staffSeat(context), async (client) => {
    const { rows } = await client.query<TeamRow>(
      "SELECT * FROM event_tickets($1, $2, $3, $4, $5)",
      [request.eventId, request.status, request.kind, request.cursor, request.limit],
    );
    const counts = await client.query<CountsRow>("SELECT * FROM event_ticket_counts($1)", [
      request.eventId,
    ]);
    const row = counts.rows[0] as CountsRow;
    return {
      tickets: rows.map(teamOf),
      counts: {
        open: row.open,
        withQuestify: row.with_questify,
        closed: row.closed,
        waitingByKind: row.waiting_by_kind,
      },
    };
  });
}

export type Escalated = Readonly<{ ticketId: string; queue: "questify"; replayed: boolean }>;

/** An owner's or editor's escalation to Questify with a note (FR-1823); audited by the database, never the note. */
export function staffEscalate(
  deps: TicketDeps,
  context: OrganizerContext,
  request: Readonly<{ eventId: string; ticketId: string; note: string; requestId: string }>,
): Promise<Done<Escalated>> {
  return run(deps, staffSeat(context), async (client) => {
    const { rows } = await client.query<{ ticket_id: string; replayed: boolean }>(
      "SELECT * FROM staff_escalate_ticket($1, $2, $3, $4)",
      [request.eventId, request.ticketId, request.note, request.requestId],
    );
    const row = rows[0] as { ticket_id: string; replayed: boolean };
    return { ticketId: row.ticket_id, queue: "questify", replayed: row.replayed };
  });
}

// ---------------------------------------------------------------- the operator's reads

/** One ticket for the operator: never who answered. */
export type OperatorTicket = Readonly<{
  id: string;
  kind: TicketKind;
  quest: Readonly<{ id: string; title: Title }> | null;
  username: string | null;
  avatar: string;
  text: string;
  marked: boolean;
  status: "open" | "closed";
  outcome: "answered" | "solved" | null;
  reply: string | null;
  createdAt: Date;
  closedAt: Date | null;
}>;

/** An open ticket the operator may see, or a closed one they answered (HT404 otherwise). */
export function operatorTicket(
  deps: TicketDeps,
  playerId: string,
  request: Readonly<{ eventId: string; ticketId: string }>,
): Promise<Done<OperatorTicket>> {
  return run(deps, { playerId }, async (client) => {
    const { rows } = await client.query<TeamRow>("SELECT * FROM operator_ticket($1, $2)", [
      request.eventId,
      request.ticketId,
    ]);
    const row = rows[0] as TeamRow;
    return {
      id: row.id,
      kind: row.kind,
      quest:
        row.quest_id === null
          ? null
          : { id: row.quest_id, title: { ar: row.quest_title_ar, en: row.quest_title_en } },
      username: row.username,
      avatar: row.avatar,
      text: row.body,
      marked: row.marked,
      status: row.status,
      outcome: row.outcome,
      reply: row.reply,
      createdAt: row.created_at,
      closedAt: row.closed_at,
    };
  });
}

/** Where a page of the inbox ends: created_at in microseconds, the kind and the id. */
export type InboxPosition = Readonly<{
  position: string;
  kind: "submission" | "ticket";
  id: string;
}>;

export type InboxItem = Readonly<{
  kind: "submission" | "ticket";
  id: string;
  createdAt: Date;
  questTitle: Title | null;
  username: string | null;
  avatar: string;
  /** The first 120 characters of the text; null once an account was erased. */
  preview: string | null;
  marked: boolean;
  ticketKind: TicketKind | null;
}>;

export type Inbox = Readonly<{
  items: InboxItem[];
  /** The last item's position, to start the next page; null after a short page. */
  next: InboxPosition | null;
  abilities: Readonly<{ review: boolean; helpDesk: boolean }>;
}>;

type InboxRow = {
  kind: InboxItem["kind"];
  id: string;
  created_at: Date;
  quest_id: string | null;
  quest_title_ar: string | null;
  quest_title_en: string | null;
  username: string | null;
  avatar: string;
  preview: string | null;
  marked: boolean;
  ticket_kind: TicketKind | null;
  position: string;
};

type CountRow = { submissions: number; tickets: number; review: boolean; help: boolean };

/** The operator's Inbox (FR-927): submissions to review and open tickets, one list, oldest first. */
export function operatorInbox(
  deps: TicketDeps,
  playerId: string,
  request: Readonly<{ eventId: string; after: InboxPosition | null; limit: number }>,
): Promise<Done<Inbox>> {
  return run(deps, { playerId }, async (client) => {
    const { rows } = await client.query<InboxRow>(
      "SELECT * FROM operator_inbox($1, $2, $3, $4, $5)",
      [
        request.eventId,
        request.after?.position ?? null,
        request.after?.kind ?? null,
        request.after?.id ?? null,
        request.limit,
      ],
    );
    const counted = await client.query<CountRow>("SELECT * FROM operator_inbox_count($1)", [
      request.eventId,
    ]);
    const seat = counted.rows[0] as CountRow;
    const last = rows[request.limit - 1];
    return {
      items: rows.map((row) => ({
        kind: row.kind,
        id: row.id,
        createdAt: row.created_at,
        questTitle: titleOf(row.quest_title_ar, row.quest_title_en, row.quest_id),
        username: row.username,
        avatar: row.avatar,
        preview: row.preview,
        marked: row.marked,
        ticketKind: row.ticket_kind,
      })),
      next: last === undefined ? null : { position: last.position, kind: last.kind, id: last.id },
      abilities: { review: seat.review, helpDesk: seat.help },
    };
  });
}

export type InboxCount = Readonly<{ submissions: number; tickets: number; total: number }>;

/** The Inbox badge: what waits for this operator, counted by the same rules as the list. */
export function operatorInboxCount(
  deps: TicketDeps,
  playerId: string,
  eventId: string,
): Promise<Done<InboxCount>> {
  return run(deps, { playerId }, async (client) => {
    const { rows } = await client.query<CountRow>("SELECT * FROM operator_inbox_count($1)", [
      eventId,
    ]);
    const row = rows[0] as CountRow;
    return {
      submissions: row.submissions,
      tickets: row.tickets,
      total: row.submissions + row.tickets,
    };
  });
}

// ---------------------------------------------------------------- retention

/** One run of the retention sweep (Q-210): at most 1000 tickets past their 90 days. Answers how many went. */
export async function purgeEndedTickets(deps: TicketDeps): Promise<number> {
  return withConnection(deps.pool, (client) =>
    withRequestContext(client, {}, async () => {
      const { rows } = await client.query<{ purged: number }>(
        "SELECT purge_ended_tickets(1000) AS purged",
      );
      return rows[0]?.purged ?? 0;
    }),
  );
}
