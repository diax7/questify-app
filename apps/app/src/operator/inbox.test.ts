import { describe, expect, it } from "vitest";
import {
  answerResult,
  answerTicket,
  fetchInbox,
  fetchInboxTotal,
  inboxAnswer,
  inboxOf,
  ticketOf,
} from "#src/operator/inbox.ts";
import { firstOf, type ReviewItem } from "#src/operator/review.ts";

const ITEM = {
  kind: "ticket",
  id: "4",
  createdAt: "2030-01-01T09:00:00.000Z",
  questTitle: null,
  username: "sara",
  avatar: "falcon",
  preview: "The QR is missing",
  marked: false,
  ticketKind: "problem",
};
const INBOX = { items: [ITEM], nextCursor: null, abilities: { review: true, helpDesk: true } };
const TICKET = {
  id: "4",
  kind: "problem",
  quest: { id: "q1", title: { ar: null, en: "Find the code" } },
  username: null,
  avatar: "falcon",
  text: "The QR is missing",
  marked: true,
  status: "open",
  outcome: null,
  reply: null,
  createdAt: "2030-01-01T09:00:00.000Z",
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
const recording = (answer: unknown) => {
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

describe("staff mode's Inbox (T-310, FR-927)", () => {
  it("reads the merged list, and anything of another shape as a failure", () => {
    expect(inboxOf(INBOX)).toEqual(INBOX);
    expect(inboxOf({ ...INBOX, items: [{ ...ITEM, kind: "flag" }] })).toBeUndefined();
    expect(inboxOf({ ...INBOX, items: [{ ...ITEM, ticketKind: "praise" }] })).toBeUndefined();
    expect(inboxOf({ ...INBOX, items: [{ ...ITEM, questTitle: "Quest" }] })).toBeUndefined();
    expect(inboxOf({ ...INBOX, abilities: { review: true } })).toBeUndefined();
    expect(inboxOf({ ...INBOX, nextCursor: 5 })).toBeUndefined();
    expect(inboxOf("nope")).toBeUndefined();
  });

  it("says off with neither ability, removed for a former operator, failed otherwise", () => {
    expect(inboxAnswer(ok(INBOX))).toEqual({ kind: "inbox", inbox: INBOX });
    expect(inboxAnswer(error(403, "ability_off"))).toEqual({ kind: "off" });
    expect(inboxAnswer(error(403, "not_operator"))).toEqual({ kind: "removed" });
    expect(inboxAnswer(error(500, "internal"))).toEqual({ kind: "failed" });
    expect(inboxAnswer({ kind: "network" })).toEqual({ kind: "failed" });
    expect(inboxAnswer(ok({}))).toEqual({ kind: "failed" });
  });

  it("asks for the next page by its cursor, and reads the badge's total", async () => {
    const { sent, session } = recording(ok(INBOX));
    await fetchInbox(session, "e1", null);
    await fetchInbox(session, "e1", "a b");
    expect(sent).toEqual([
      { method: "GET", path: "/v1/operator/events/e1/inbox" },
      { method: "GET", path: "/v1/operator/events/e1/inbox?cursor=a%20b" },
    ]);
    expect(await fetchInboxTotal(recording(ok({ total: 5 })).session, "e1")).toBe(5);
    expect(await fetchInboxTotal(recording(ok({})).session, "e1")).toBeNull();
    expect(await fetchInboxTotal(recording({ kind: "network" }).session, "e1")).toBeNull();
  });

  it("reads one ticket, and a malformed one as nothing", () => {
    expect(ticketOf({ ticket: TICKET })).toEqual(TICKET);
    expect(ticketOf({ ticket: { ...TICKET, quest: null } })).toMatchObject({ quest: null });
    expect(ticketOf({ ticket: { ...TICKET, kind: "praise" } })).toBeUndefined();
    expect(ticketOf({ ticket: { ...TICKET, status: "waiting" } })).toBeUndefined();
    expect(ticketOf({ ticket: { ...TICKET, text: null } })).toBeUndefined();
    expect(ticketOf({})).toBeUndefined();
  });

  it("answers with a reply or solved, and goes back when someone answered first", async () => {
    const { sent, session } = recording(ok({ ticketId: "4", outcome: "answered" }));
    expect(
      await answerTicket(session, { eventId: "e1", ticketId: "4", reply: " On it ", key: "k" }),
    ).toEqual({ kind: "done" });
    await answerTicket(session, { eventId: "e1", ticketId: "4", reply: null, key: "k2" });
    expect(sent).toEqual([
      {
        method: "POST",
        path: "/v1/operator/events/e1/tickets/4/answer",
        body: { reply: "On it" },
        headers: { "idempotency-key": "k" },
      },
      {
        method: "POST",
        path: "/v1/operator/events/e1/tickets/4/answer",
        body: {},
        headers: { "idempotency-key": "k2" },
      },
    ]);
    expect(answerResult(error(409, "already_closed"))).toEqual({ kind: "gone" });
    expect(answerResult(error(404, "not_found"))).toEqual({ kind: "gone" });
    expect(answerResult(error(422, "invalid_text"))).toEqual({
      kind: "refused",
      message: { ar: "م", en: "m" },
    });
    expect(answerResult({ kind: "network" })).toEqual({ kind: "network" });
  });
});

const item = (id: string): ReviewItem => ({
  id,
  questTitle: { ar: null, en: "Tell us" },
  username: "sara",
  avatar: "falcon",
  text: "Hi",
  points: 10,
  marked: false,
});

describe("the review card the Inbox opens", () => {
  it("puts the opened submission first, and keeps the order otherwise", () => {
    const queue = [item("1"), item("2"), item("3")];
    expect(firstOf(queue, "3").map((one) => one.id)).toEqual(["3", "1", "2"]);
    expect(firstOf(queue, "9").map((one) => one.id)).toEqual(["1", "2", "3"]);
    expect(firstOf(queue, undefined).map((one) => one.id)).toEqual(["1", "2", "3"]);
  });
});
