import { describe, expect, it } from "vitest";
import {
  markTicketsSeen,
  openPlatformTicket,
  openTicket,
  operatorAnswer,
  operatorInbox,
  operatorInboxCount,
  ownTickets,
  purgeEndedTickets,
  staffEscalate,
  staffTickets,
} from "#src/tickets/tickets";
import { fakePool, pgError } from "#test/support/fake-pool";

const PLAYER = "22222222-2222-4222-8222-222222222222";
const EVENT = "33333333-3333-4333-8333-333333333333";
const STAFF = {
  staffUserId: "44444444-4444-4444-8444-444444444444",
  organizerId: "55555555-5555-4555-8555-555555555555",
};
const AT = new Date("2030-01-01T10:00:00Z");
const SEND = {
  playerId: PLAYER,
  eventId: EVENT,
  kind: "question",
  questId: null,
  reportedUsername: null,
  text: "Where?",
  idempotencyKey: "k",
} as const;

const refusing = (fields: Record<string, string>) =>
  fakePool(() => {
    throw pgError(fields);
  }).pool;

describe("refusals (migrations 0059 and 0061's SQLSTATEs)", () => {
  it.each([
    [{ code: "HT404" }, { kind: "not_found" }],
    [{ code: "AN404" }, { kind: "not_found" }],
    [{ code: "HQ404" }, { kind: "unknown_quest" }],
    [{ code: "HK422" }, { kind: "invalid_kind" }],
    [{ code: "QK422" }, { kind: "key_reused" }],
    [
      { code: "SV422", detail: "too_long" },
      { kind: "invalid_text", problem: "too_long" },
    ],
    [{ code: "HT403", detail: "not_member" }, { kind: "not_member" }],
    [{ code: "HT403", detail: "feature_off" }, { kind: "feature_off" }],
    [{ code: "HT403", detail: "sending_closed" }, { kind: "sending_closed" }],
    [{ code: "HT403", detail: "self_answer" }, { kind: "self_answer" }],
    [{ code: "HT403", detail: "outside_quests" }, { kind: "outside_quests" }],
    [{ code: "HT409", detail: "too_many_open" }, { kind: "too_many_open" }],
    [{ code: "HT409", detail: "event_closed" }, { kind: "event_closed" }],
    [{ code: "HT409", detail: "already_closed" }, { kind: "already_closed" }],
    [
      { code: "HT429", detail: "3600" },
      { kind: "too_many_tickets", retryAfterSeconds: 3600 },
    ],
    [
      { code: "HT429", detail: "0" },
      { kind: "too_many_tickets", retryAfterSeconds: 1 },
    ],
    [{ code: "OP403" }, { kind: "not_operator" }],
    [{ code: "OA403" }, { kind: "ability_off" }],
    [{ code: "HQ422" }, { kind: "invalid_kind" }],
    [{ code: "HR422", detail: "username_required" }, { kind: "username_required" }],
    [{ code: "HR422", detail: "username_unexpected" }, { kind: "invalid_kind" }],
    [{ code: "HR404", detail: "unknown_player" }, { kind: "unknown_player" }],
    [{ code: "HR403", detail: "self_report" }, { kind: "self_report" }],
    [
      { code: "HD422", detail: "os_version" },
      { kind: "invalid_device", field: "os_version" },
    ],
    [{ code: "HT409", detail: "already_reported" }, { kind: "already_reported" }],
    [{ code: "HT409", detail: "not_open" }, { kind: "not_open" }],
    [{ code: "HT409", detail: "moved" }, { kind: "moved" }],
    [{ code: "HT409", detail: "not_escalated" }, { kind: "not_escalated" }],
    [{ code: "HT409", detail: "anything" }, { kind: "already_closed" }],
  ])("reads %o", async (fields, expected) => {
    expect(await openTicket({ pool: refusing(fields) }, SEND)).toEqual(expected);
  });

  it("reads the answer key's unique index as a reused key, and any other unique violation as an error", async () => {
    const pool = refusing({ code: "23505", constraint: "ticket_answer_key_operator" });
    expect(await openTicket({ pool }, SEND)).toEqual({ kind: "key_reused" });
    const report = refusing({ code: "23505", constraint: "ticket_open_report_key" });
    expect(await openTicket({ pool: report }, SEND)).toEqual({ kind: "already_reported" });
    await expect(
      openTicket(
        { pool: refusing({ code: "23505", constraint: "ticket_player_id_idempotency_key_key" }) },
        SEND,
      ),
    ).rejects.toThrow();
  });

  it("throws anything else, an unknown HT403 detail included", async () => {
    await expect(openTicket({ pool: refusing({ code: "23505" }) }, SEND)).rejects.toThrow();
    await expect(
      openTicket({ pool: refusing({ code: "HT403", detail: "other" }) }, SEND),
    ).rejects.toThrow();
  });
});

const teamRow = {
  id: "3",
  kind: "question",
  quest_id: "q",
  quest_title_ar: "م",
  quest_title_en: "Q",
  enrollment_id: "e",
  username: "sara",
  avatar: "falcon",
  body: "Hi",
  marked: false,
  status: "closed",
  outcome: "answered",
  reply: "Yes",
  answered_by: "operator",
  answerer: null,
  answerer_deleted: true,
  created_at: AT,
  closed_at: AT,
  queue: "event",
  reported_enrollment_id: null,
  reported_username: null,
  escalated_at: null,
  escalation_note: null,
  escalated_by: null,
  returned_at: null,
  return_note: null,
};

const inboxRow = (id: string, kind: "submission" | "ticket") => ({
  kind,
  id,
  created_at: AT,
  quest_id: kind === "ticket" ? null : "q",
  quest_title_ar: null,
  quest_title_en: kind === "ticket" ? null : "Tell us",
  username: "sara",
  avatar: "falcon",
  preview: "Hi",
  marked: false,
  ticket_kind: kind === "ticket" ? "question" : null,
  position: `17${id}`,
});

describe("the calls", () => {
  it("sends the ticket's fields and reads the answer", async () => {
    const seen: unknown[] = [];
    const { pool, queries } = fakePool((_sql, values) => {
      seen.push(values);
      return {
        rows: [{ ticket_id: "9", status: "open", created_at: AT, marked: true, replayed: false }],
      };
    });
    expect(await openTicket({ pool }, SEND)).toEqual({
      kind: "done",
      value: { ticketId: "9", status: "open", createdAt: AT, marked: true, replayed: false },
    });
    expect(queries).toEqual(["SELECT * FROM open_ticket($1, $2, $3, $4, $5, $6)"]);
    expect(seen).toEqual([[EVENT, "question", null, null, "Where?", "k"]]);
  });

  it("sends a report's username, and a platform ticket's device facts or nulls", async () => {
    const seen: unknown[] = [];
    const { pool, queries } = fakePool((_sql, values) => {
      seen.push(values);
      return {
        rows: [{ ticket_id: "9", status: "open", created_at: AT, marked: false, replayed: true }],
      };
    });
    await openTicket({ pool }, { ...SEND, kind: "report_player", reportedUsername: "sara" });
    const device = {
      appVersion: "1.4.0",
      platform: "ios",
      osVersion: "18.1",
      model: null,
    } as const;
    expect(
      await openPlatformTicket(
        { pool },
        { playerId: PLAYER, kind: "app_problem", text: "Blank", device, idempotencyKey: "p" },
      ),
    ).toEqual({
      kind: "done",
      value: { ticketId: "9", status: "open", createdAt: AT, marked: false, replayed: true },
    });
    await openPlatformTicket(
      { pool },
      { playerId: PLAYER, kind: "suggestion", text: "Idea", device: null, idempotencyKey: "s" },
    );
    expect(queries.slice(1)).toEqual([
      "SELECT * FROM open_platform_ticket($1, $2, $3, $4, $5, $6, $7)",
      "SELECT * FROM open_platform_ticket($1, $2, $3, $4, $5, $6, $7)",
    ]);
    expect(seen).toEqual([
      [EVENT, "report_player", null, "sara", "Where?", "k"],
      ["app_problem", "Blank", "1.4.0", "ios", "18.1", null, "p"],
      ["suggestion", "Idea", null, null, null, null, "s"],
    ]);
  });

  it("escalates with the note and the request id", async () => {
    const seen: unknown[] = [];
    const { pool } = fakePool((_sql, values) => {
      seen.push(values);
      return { rows: [{ ticket_id: "4", queue: "questify", replayed: false }] };
    });
    expect(
      await staffEscalate({ pool }, STAFF, {
        eventId: EVENT,
        ticketId: "4",
        note: "Tried",
        requestId: "r",
      }),
    ).toEqual({ kind: "done", value: { ticketId: "4", queue: "questify", replayed: false } });
    expect(seen).toEqual([[EVENT, "4", "Tried", "r"]]);
  });

  it("reads the player's own tickets with no answerer, and marks them seen anywhere with null", async () => {
    const seen: unknown[] = [];
    const { pool } = fakePool((sql, values) => {
      if (sql.includes("mark_tickets_seen")) {
        seen.push(values);
        return { rows: [{ marked: 1 }] };
      }
      return {
        rows: [
          {
            id: "1",
            event_id: EVENT,
            event_name_ar: null,
            event_name_en: "Fest",
            kind: "problem",
            quest_id: null,
            quest_title_ar: null,
            quest_title_en: null,
            body: "No QR",
            status: "closed",
            outcome: "solved",
            reply: null,
            closed_at: AT,
            created_at: AT,
            unread: true,
            with_questify: false,
            answered_by_team: "questify",
            reported_username: "khalid",
          },
        ],
      };
    });
    expect(await ownTickets({ pool }, PLAYER, null)).toEqual([
      {
        id: "1",
        event: { id: EVENT, name: { ar: null, en: "Fest" } },
        kind: "problem",
        quest: null,
        text: "No QR",
        status: "closed",
        outcome: "solved",
        reply: null,
        closedAt: AT,
        createdAt: AT,
        unread: true,
        withQuestify: false,
        answeredBy: "questify",
        reportedUsername: "khalid",
      },
    ]);
    expect(await markTicketsSeen({ pool }, PLAYER, { eventId: null, ids: ["1"] })).toBe(1);
    expect(seen).toEqual([[null, ["1"]]]);
  });

  it("passes a null reply for solved", async () => {
    const seen: unknown[] = [];
    const { pool } = fakePool((_sql, values) => {
      seen.push(values);
      return { rows: [{ ticket_id: "5", outcome: "solved", replayed: false }] };
    });
    expect(
      await operatorAnswer({ pool }, PLAYER, {
        eventId: EVENT,
        ticketId: "5",
        reply: null,
        idempotencyKey: "k",
      }),
    ).toEqual({ kind: "done", value: { ticketId: "5", outcome: "solved", replayed: false } });
    expect(seen).toEqual([[EVENT, "5", null, "k"]]);
  });

  it("names who answered on the team's page, with the tab counts", async () => {
    const { pool } = fakePool((sql) =>
      sql.includes("event_ticket_counts")
        ? { rows: [{ open: 2, with_questify: 3, closed: 1, waiting_by_kind: { prize: 4 } }] }
        : {
            rows: [
              teamRow,
              {
                ...teamRow,
                id: "4",
                queue: "questify",
                answered_by: "admin",
                reported_enrollment_id: "r",
                reported_username: null,
                escalated_at: AT,
                escalation_note: "Tried",
                escalated_by: "a@team.test",
                returned_at: AT,
                return_note: "Yours",
              },
            ],
          },
    );
    const page = await staffTickets({ pool }, STAFF, {
      eventId: EVENT,
      status: "closed",
      kind: null,
      cursor: null,
      limit: 50,
    });
    expect(page).toMatchObject({
      kind: "done",
      value: {
        counts: { open: 2, withQuestify: 3, closed: 1, waitingByKind: { prize: 4 } },
        tickets: [
          {
            quest: { id: "q", title: { ar: "م", en: "Q" } },
            answeredBy: { kind: "operator", name: null, deleted: true },
            queue: "event",
            reported: null,
            escalation: null,
            returned: null,
          },
          {
            queue: "questify",
            answeredBy: { kind: "admin" },
            reported: { enrollmentId: "r", username: null },
            escalation: { at: AT, note: "Tried", by: "a@team.test" },
            returned: { at: AT, note: "Yours" },
          },
        ],
      },
    });
  });

  it("pages the inbox from the last full page's position, with the abilities", async () => {
    const seen: unknown[] = [];
    const { pool } = fakePool((sql, values) => {
      if (sql.includes("operator_inbox_count")) {
        return { rows: [{ submissions: 1, tickets: 1, review: true, help: false }] };
      }
      seen.push(values);
      return { rows: [inboxRow("1", "submission"), inboxRow("2", "ticket")] };
    });
    const inbox = await operatorInbox({ pool }, PLAYER, {
      eventId: EVENT,
      after: { position: "1", kind: "ticket", id: "1" },
      limit: 2,
    });
    expect(seen).toEqual([[EVENT, "1", "ticket", "1", 2]]);
    expect(inbox).toMatchObject({
      kind: "done",
      value: {
        next: { position: "172", kind: "ticket", id: "2" },
        abilities: { review: true, helpDesk: false },
        items: [
          { kind: "submission", questTitle: { ar: null, en: "Tell us" } },
          { kind: "ticket", questTitle: null, ticketKind: "question" },
        ],
      },
    });
    const short = fakePool((sql) =>
      sql.includes("operator_inbox_count")
        ? { rows: [{ submissions: 1, tickets: 0, review: true, help: true }] }
        : { rows: [inboxRow("1", "submission")] },
    );
    expect(
      await operatorInbox({ pool: short.pool }, PLAYER, { eventId: EVENT, after: null, limit: 2 }),
    ).toMatchObject({ value: { next: null } });
    expect(await operatorInboxCount({ pool: short.pool }, PLAYER, EVENT)).toEqual({
      kind: "done",
      value: { submissions: 1, tickets: 0, total: 1 },
    });
  });

  it("purges at most 1000 a run and answers how many went", async () => {
    const { pool, queries } = fakePool(() => ({ rows: [{ purged: 7 }] }));
    expect(await purgeEndedTickets({ pool })).toBe(7);
    expect(queries).toEqual(["SELECT purge_ended_tickets(1000) AS purged"]);
  });
});
