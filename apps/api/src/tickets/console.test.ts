import { describe, expect, it } from "vitest";
import {
  adminAnswer,
  adminReturn,
  consoleTicket,
  consoleTicketCounts,
  consoleTickets,
} from "#src/tickets/console";
import { fakePool, pgError } from "#test/support/fake-pool";

const ADMIN = "66666666-6666-4666-8666-666666666666";
const AT = new Date("2030-01-01T10:00:00Z");

const queueRow = {
  id: "7",
  kind: "question",
  preview: "Please",
  marked: false,
  status: "open",
  outcome: null,
  created_at: AT,
  closed_at: null,
  username: "sara",
  organizer_id: "o",
  organizer_name: "Najd",
  event_id: "e",
  event_name_ar: null,
  event_name_en: "Fest",
  quest_title_ar: null,
  quest_title_en: "Find",
  reported_username: null,
  escalated_at: AT,
  escalated_by: "team@x.sa",
  app_version: null,
  platform: null,
  os_version: null,
  device_model: null,
};

const directRow = {
  ...queueRow,
  id: "8",
  kind: "app_problem",
  organizer_id: null,
  organizer_name: null,
  event_id: null,
  event_name_en: null,
  quest_title_en: null,
  escalated_at: null,
  escalated_by: null,
  app_version: "1.4.0",
  platform: "ios",
  os_version: "18.1",
  device_model: null,
};

const counts = { open: 2, closed: 5, open_direct: 1, open_escalated: 1 };

describe("Questify's queue (T-312)", () => {
  it("lists a page with the counts, as the admin, with every filter", async () => {
    const seen: unknown[] = [];
    const { pool, queries } = fakePool((sql, values) => {
      if (sql.includes("console_ticket_counts")) {
        return { rows: [counts] };
      }
      seen.push(values);
      return { rows: [queueRow, directRow] };
    });
    const page = await consoleTickets({ pool }, ADMIN, {
      status: "open",
      kind: "question",
      source: "escalated",
      cursor: "3",
      limit: 2,
      requestId: "r",
    });
    expect(queries).toEqual([
      "SELECT * FROM console_tickets($1, $2, $3, $4, $5, $6)",
      "SELECT * FROM console_ticket_counts()",
    ]);
    expect(seen).toEqual([["open", "question", "escalated", "3", 2, "r"]]);
    expect(page).toEqual({
      kind: "done",
      value: {
        counts: { open: 2, closed: 5, openDirect: 1, openEscalated: 1 },
        tickets: [
          {
            id: "7",
            kind: "question",
            preview: "Please",
            marked: false,
            status: "open",
            outcome: null,
            createdAt: AT,
            closedAt: null,
            username: "sara",
            event: {
              organizerId: "o",
              organizerName: "Najd",
              eventId: "e",
              name: { ar: null, en: "Fest" },
            },
            questTitle: { ar: null, en: "Find" },
            reportedUsername: null,
            escalation: { at: AT, by: "team@x.sa" },
            device: null,
          },
          expect.objectContaining({
            id: "8",
            event: null,
            questTitle: null,
            escalation: null,
            device: { appVersion: "1.4.0", platform: "ios", osVersion: "18.1", model: null },
          }),
        ],
      },
    });
  });

  it("reads the counts alone", async () => {
    const { pool } = fakePool(() => ({ rows: [counts] }));
    expect(await consoleTicketCounts({ pool }, ADMIN)).toEqual({
      kind: "done",
      value: { open: 2, closed: 5, openDirect: 1, openEscalated: 1 },
    });
  });

  it("reads one ticket with its full text, notes and answerer", async () => {
    const seen: unknown[] = [];
    const { pool } = fakePool((_sql, values) => {
      seen.push(values);
      return {
        rows: [
          {
            ...queueRow,
            body: "Please look",
            reply: "Done",
            event_status: "live",
            escalation_note: "Tried",
            returned_at: AT,
            return_note: "Yours",
            answered_by: "help@questify.sa",
          },
        ],
      };
    });
    const read = await consoleTicket({ pool }, ADMIN, { ticketId: "7", requestId: "r" });
    expect(seen).toEqual([["7", "r"]]);
    expect(read).toMatchObject({
      kind: "done",
      value: {
        id: "7",
        text: "Please look",
        reply: "Done",
        eventStatus: "live",
        escalation: { at: AT, by: "team@x.sa", note: "Tried" },
        returned: { at: AT, note: "Yours" },
        answeredBy: "help@questify.sa",
        event: { eventId: "e" },
      },
    });
    expect(Object.keys((read as { value: object }).value)).not.toContain("preview");
    const plain = fakePool(() => ({
      rows: [
        {
          ...directRow,
          body: "Blank",
          reply: null,
          event_status: null,
          escalation_note: null,
          returned_at: null,
          return_note: null,
          answered_by: null,
        },
      ],
    }));
    expect(
      await consoleTicket({ pool: plain.pool }, ADMIN, { ticketId: "8", requestId: "r" }),
    ).toMatchObject({ value: { escalation: null, returned: null, event: null } });
  });

  it("answers, solves and sends back; a refusal comes back as its kind", async () => {
    const seen: unknown[] = [];
    const { pool, queries } = fakePool((sql, values) => {
      seen.push(values);
      return sql.includes("admin_answer_ticket")
        ? { rows: [{ ticket_id: "7", outcome: "solved", replayed: true }] }
        : { rows: [{ ticket_id: "7", queue: "event", replayed: false }] };
    });
    expect(
      await adminAnswer({ pool }, ADMIN, {
        ticketId: "7",
        reply: null,
        idempotencyKey: "k",
        requestId: "r",
      }),
    ).toEqual({ kind: "done", value: { ticketId: "7", outcome: "solved", replayed: true } });
    expect(
      await adminReturn({ pool }, ADMIN, { ticketId: "7", note: "Yours", requestId: "r" }),
    ).toEqual({ kind: "done", value: { ticketId: "7", queue: "event", replayed: false } });
    expect(queries).toEqual([
      "SELECT * FROM admin_answer_ticket($1, $2, $3, $4)",
      "SELECT * FROM admin_return_ticket($1, $2, $3)",
    ]);
    expect(seen).toEqual([
      ["7", null, "k", "r"],
      ["7", "Yours", "r"],
    ]);
    const refused = fakePool(() => {
      throw pgError({ code: "HT409", detail: "not_escalated" });
    });
    expect(
      await adminReturn({ pool: refused.pool }, ADMIN, {
        ticketId: "7",
        note: "x",
        requestId: "r",
      }),
    ).toEqual({ kind: "not_escalated" });
  });
});
