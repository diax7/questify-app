import type { TicketKind } from "@questify/shared";
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
  | Readonly<{ kind: "ability_off" }>;

export type Done<T> = Readonly<{ kind: "done"; value: T }> | TicketRefusal;

const FORBIDDEN: Readonly<Record<string, TicketRefusal>> = {
  not_member: { kind: "not_member" },
  feature_off: { kind: "feature_off" },
  sending_closed: { kind: "sending_closed" },
  self_answer: { kind: "self_answer" },
  outside_quests: { kind: "outside_quests" },
};

/** The SQLSTATEs of migration 0059's doors; the DETAIL picks the answer where one code has several. */
const REFUSALS: Readonly<Record<string, (detail: string) => TicketRefusal | undefined>> = {
  HT404: () => ({ kind: "not_found" }),
  AN404: () => ({ kind: "not_found" }),
  HQ404: () => ({ kind: "unknown_quest" }),
  HK422: () => ({ kind: "invalid_kind" }),
  QK422: () => ({ kind: "key_reused" }),
  SV422: (detail) => ({ kind: "invalid_text", problem: detail }),
  HT403: (detail) => FORBIDDEN[detail],
  HT409: (detail) =>
    detail === "too_many_open"
      ? { kind: "too_many_open" }
      : detail === "event_closed"
        ? { kind: "event_closed" }
        : { kind: "already_closed" },
  HT429: (detail) => ({ kind: "too_many_tickets", retryAfterSeconds: Math.max(1, Number(detail)) }),
  OP403: () => ({ kind: "not_operator" }),
  OA403: () => ({ kind: "ability_off" }),
};

/** Runs one call in `context`; a refusal the database raises becomes its result, anything else is thrown. */
async function run<T>(
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
    const pg = error as { code?: string; detail?: string };
    const refusal = REFUSALS[String(pg.code)]?.(pg.detail ?? "");
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

type Title = Readonly<{ ar: string | null; en: string | null }>;
const titleOf = (ar: string | null, en: string | null, id: string | null): Title | null =>
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

/** The player's question or problem report (FR-337); `open_ticket` checks every rule (migration 0059). */
export function openTicket(
  deps: TicketDeps,
  request: Readonly<{
    playerId: string;
    eventId: string;
    kind: TicketKind;
    questId: string | null;
    text: string;
    idempotencyKey: string;
  }>,
): Promise<Done<Opened>> {
  return run(deps, { playerId: request.playerId }, async (client) => {
    const { rows } = await client.query<{
      ticket_id: string;
      status: Opened["status"];
      created_at: Date;
      marked: boolean;
      replayed: boolean;
    }>("SELECT * FROM open_ticket($1, $2, $3, $4, $5)", [
      request.eventId,
      request.kind,
      request.questId,
      request.text,
      request.idempotencyKey,
    ]);
    const row = rows[0];
    // Stryker disable next-line ConditionalExpression,BlockStatement: unreachable: open_ticket answers one row or raises
    if (row === undefined) {
      throw new Error("open_ticket answered no row.");
    }
    return {
      ticketId: row.ticket_id,
      status: row.status,
      createdAt: row.created_at,
      marked: row.marked,
      replayed: row.replayed,
    };
  });
}

/** One of the player's own tickets: never who answered, only "the event team" (ADR-247). */
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

/** How many of the calling player's answers in an event they have not seen (Home's strip). */
export async function readUnreadTickets(client: PoolClient, eventId: string): Promise<number> {
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

type AnsweredRow = { ticket_id: string; outcome: Answered["outcome"]; replayed: boolean };

const answeredOf = (rows: readonly AnsweredRow[]): Answered => {
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
  /** Who answered, for accountability: the operator's @username or the staff member's email. */
  answeredBy: Readonly<{
    kind: "operator" | "staff";
    name: string | null;
    deleted: boolean;
  }> | null;
  createdAt: Date;
  closedAt: Date | null;
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
  answered_by: "operator" | "staff" | null;
  answerer: string | null;
  answerer_deleted: boolean;
  created_at: Date;
  closed_at: Date | null;
};

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
});

export type TeamPage = Readonly<{
  tickets: TeamTicket[];
  counts: Readonly<{ open: number; closed: number }>;
}>;

/** The dashboard's Help desk page (FR-339): one tab, one kind or all, one page, and both tabs' counts. */
export function staffTickets(
  deps: TicketDeps,
  context: OrganizerContext,
  request: Readonly<{
    eventId: string;
    status: "open" | "closed";
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
    const counts = await client.query<{ open: number; closed: number }>(
      "SELECT * FROM event_ticket_counts($1)",
      [request.eventId],
    );
    return {
      tickets: rows.map(teamOf),
      counts: counts.rows[0] ?? { open: 0, closed: 0 },
    };
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
    const { rows } = await client.query<Omit<TeamRow, "enrollment_id" | "answered_by">>(
      "SELECT * FROM operator_ticket($1, $2)",
      [request.eventId, request.ticketId],
    );
    const row = rows[0] as Omit<TeamRow, "enrollment_id" | "answered_by">;
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
