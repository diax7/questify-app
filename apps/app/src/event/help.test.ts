import { describe, expect, it } from "vitest";
import {
  canSendTicket,
  fetchMyTickets,
  markSeen,
  sendAnswer,
  sendTicket,
  sendingOffFor,
  sendingOffOf,
  ticketStatusKey,
  ticketsOf,
  type MyTicket,
} from "#src/event/help.ts";

const TICKET = {
  id: "7",
  kind: "problem",
  quest: { id: "q1", title: { ar: null, en: "Find the code" } },
  text: "No QR here",
  status: "closed",
  outcome: "answered",
  reply: "Back in place",
  closedAt: "2030-01-01T10:00:00.000Z",
  createdAt: "2030-01-01T09:00:00.000Z",
  unread: true,
};

const ok = (body: unknown) => ({ kind: "ok" as const, status: 200, body, headers: new Headers() });
const error = (status: number, code: string) => ({
  kind: "error" as const,
  status,
  code,
  message: { ar: "م", en: "m" },
  details: {},
  headers: new Headers(),
});

/** A session that records each request and answers with `answer`. */
const recording = (answer: unknown = ok({ tickets: [] })) => {
  const sent: unknown[] = [];
  return {
    sent,
    session: {
      request: async (request: unknown) => {
        sent.push(request);
        return answer as ReturnType<typeof ok>;
      },
    },
  };
};

describe("the player's requests (T-310)", () => {
  it("reads one event's list and the profile's list with its events", () => {
    expect(ticketsOf({ tickets: [TICKET] })).toEqual([
      {
        id: "7",
        event: null,
        kind: "problem",
        quest: TICKET.quest,
        text: "No QR here",
        status: "closed",
        outcome: "answered",
        reply: "Back in place",
        createdAt: TICKET.createdAt,
        unread: true,
      },
    ]);
    const withEvent = { ...TICKET, event: { id: "e1", name: { ar: "مهرجان", en: "Fest" } } };
    expect(ticketsOf({ tickets: [withEvent] })?.[0]?.event).toEqual(withEvent.event);
    expect(ticketsOf({ tickets: [{ ...TICKET, quest: null }] })?.[0]?.quest).toBeNull();
  });

  it.each([
    { ...TICKET, kind: "praise" },
    { ...TICKET, status: "waiting" },
    { ...TICKET, outcome: "done" },
    { ...TICKET, reply: 5 },
    { ...TICKET, unread: "yes" },
    { ...TICKET, quest: { id: "q1", title: "Find" } },
    { ...TICKET, event: { id: 1, name: { ar: null, en: "Fest" } } },
    { ...TICKET, text: null },
  ])("reads a malformed request as a failure: %o", (ticket) => {
    expect(ticketsOf({ tickets: [ticket] })).toBeUndefined();
  });

  it("reads a body of another shape as a failure", () => {
    expect(ticketsOf({ tickets: "none" })).toBeUndefined();
    expect(ticketsOf(null)).toBeUndefined();
  });

  it("names where a request stands", () => {
    expect(ticketStatusKey({ status: "open", outcome: null })).toBe("help.status.open");
    expect(ticketStatusKey({ status: "closed", outcome: "answered" })).toBe("help.status.answered");
    expect(ticketStatusKey({ status: "closed", outcome: "solved" })).toBe("help.status.solved");
  });
});

describe("when sending is off", () => {
  const NOW = Date.parse("2030-02-01T00:00:00.000Z");
  const open = { helpOn: true, standing: "active", statusNow: "live", endsAt: null } as const;

  it("is open to an active member of a scheduled, live or recently ended event", () => {
    expect(sendingOffFor(open, NOW)).toBeNull();
    expect(sendingOffFor({ ...open, statusNow: "scheduled" }, NOW)).toBeNull();
    expect(
      sendingOffFor({ ...open, statusNow: "ended", endsAt: "2030-01-03T00:00:00.000Z" }, NOW),
    ).toBeNull();
  });

  it("is off with the switch, for anyone not active, and 30 days after the end or in a draft or archive", () => {
    expect(sendingOffFor({ ...open, helpOn: false }, NOW)).toBe("feature_off");
    expect(sendingOffFor({ ...open, standing: "pending" }, NOW)).toBe("not_member");
    expect(sendingOffFor({ ...open, standing: null }, NOW)).toBe("not_member");
    expect(
      sendingOffFor({ ...open, statusNow: "ended", endsAt: "2030-01-02T00:00:00.000Z" }, NOW),
    ).toBe("sending_closed");
    expect(sendingOffFor({ ...open, statusNow: "draft" }, NOW)).toBe("sending_closed");
    expect(sendingOffFor({ ...open, statusNow: "archived" }, NOW)).toBe("sending_closed");
  });

  it("reads the server's refusals that hide the form", () => {
    expect(sendingOffOf("feature_off")).toBe("feature_off");
    expect(sendingOffOf("not_member")).toBe("not_member");
    expect(sendingOffOf("sending_closed")).toBe("sending_closed");
    expect(sendingOffOf("too_many_open")).toBeNull();
  });
});

describe("sending", () => {
  it("answers each refusal in the screen's words", () => {
    expect(sendAnswer(ok({ ticket: { id: "1" } }))).toEqual({ kind: "sent" });
    expect(sendAnswer(error(403, "sending_closed"))).toEqual({
      kind: "off",
      why: "sending_closed",
    });
    expect(sendAnswer(error(409, "too_many_open"))).toEqual({ kind: "too_many_open" });
    expect(sendAnswer(error(429, "too_many_tickets"))).toEqual({ kind: "too_many" });
    expect(sendAnswer(error(422, "invalid_text"))).toEqual({
      kind: "refused",
      message: { ar: "م", en: "m" },
    });
    expect(sendAnswer({ kind: "network" })).toEqual({ kind: "network" });
    expect(sendAnswer({ kind: "signed_out" })).toEqual({ kind: "signed_out" });
  });

  it("bounds the text as the server does", () => {
    expect(canSendTicket("  ")).toBe(false);
    expect(canSendTicket(" a ")).toBe(true);
    expect(canSendTicket("x".repeat(1000))).toBe(true);
    expect(canSendTicket("x".repeat(1001))).toBe(false);
  });

  it("sends the kind, the text, the quest only when there is one, and the key", async () => {
    const { sent, session } = recording(ok({}));
    await sendTicket(session, {
      eventId: "e 1",
      kind: "question",
      questId: null,
      text: "Hi",
      key: "k",
    });
    await sendTicket(session, {
      eventId: "e1",
      kind: "problem",
      questId: "q1",
      text: "No QR",
      key: "k2",
    });
    expect(sent).toEqual([
      {
        method: "POST",
        path: "/v1/events/e%201/tickets",
        body: { kind: "question", text: "Hi" },
        headers: { "idempotency-key": "k" },
      },
      {
        method: "POST",
        path: "/v1/events/e1/tickets",
        body: { kind: "problem", text: "No QR", questId: "q1" },
        headers: { "idempotency-key": "k2" },
      },
    ]);
  });

  it("reads one event's list or every event's, and nothing on a failure", async () => {
    const one = recording(ok({ tickets: [TICKET] }));
    expect(await fetchMyTickets(one.session, "e1")).toHaveLength(1);
    expect(await fetchMyTickets(one.session, null)).toHaveLength(1);
    expect(one.sent).toEqual([
      { method: "GET", path: "/v1/events/e1/tickets/mine" },
      { method: "GET", path: "/v1/me/tickets" },
    ]);
    expect(await fetchMyTickets(recording({ kind: "network" }).session, "e1")).toBeUndefined();
  });

  it("marks only unseen answers, at most 50, and sends nothing when none", async () => {
    const tickets = Array.from({ length: 60 }, (_, index) => ({
      ...(ticketsOf({ tickets: [TICKET] })?.[0] as MyTicket),
      id: String(index),
      unread: index !== 0,
    }));
    const { sent, session } = recording(ok({}));
    await markSeen(session, null, tickets);
    await markSeen(session, "e1", tickets.slice(0, 1));
    expect(sent).toEqual([
      {
        method: "POST",
        path: "/v1/me/tickets/seen",
        body: { ids: tickets.slice(1, 51).map((ticket) => ticket.id) },
      },
    ]);
    await markSeen(session, "e1", tickets.slice(1, 2));
    expect(sent[1]).toEqual({
      method: "POST",
      path: "/v1/events/e1/tickets/seen",
      body: { ids: ["1"] },
    });
  });
});
