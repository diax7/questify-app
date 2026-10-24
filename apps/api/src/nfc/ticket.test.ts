import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { TICKET_SECONDS, createTicketKey, issueTicket, ticketHolds } from "#src/nfc/ticket";

const KEY = createTicketKey("q".repeat(32));
const NOW = Date.UTC(2026, 9, 24, 12, 0, 0);
const FIELDS = {
  eventId: randomUUID(),
  questId: randomUUID(),
  operatorId: randomUUID(),
  tagId: randomUUID(),
} as const;

describe("write tickets (T-308, CTO B)", () => {
  it("refuses a short secret", () => {
    expect(() => createTicketKey("q".repeat(31))).toThrow(/QR_SECRET must be at least 32/);
  });

  it("holds for its own four ids until it expires, upper-case ids alike", () => {
    const ticket = issueTicket(KEY, FIELDS, NOW);
    expect(ticket).toMatch(/^[A-Za-z0-9_-]{114}$/);
    expect(ticketHolds(KEY, ticket, FIELDS, NOW)).toBe(true);
    expect(ticketHolds(KEY, ticket, FIELDS, NOW + TICKET_SECONDS * 1000)).toBe(true);
    expect(ticketHolds(KEY, ticket, FIELDS, NOW + (TICKET_SECONDS + 1) * 1000)).toBe(false);
    expect(ticketHolds(KEY, ticket, { ...FIELDS, tagId: FIELDS.tagId.toUpperCase() }, NOW)).toBe(
      true,
    );
  });

  it("never holds for another event, quest, operator or tag", () => {
    const ticket = issueTicket(KEY, FIELDS, NOW);
    for (const field of ["eventId", "questId", "operatorId", "tagId"] as const) {
      expect(ticketHolds(KEY, ticket, { ...FIELDS, [field]: randomUUID() }, NOW), field).toBe(
        false,
      );
    }
  });

  it("refuses another key, a changed byte, another shape and a non-canonical encoding", () => {
    const ticket = issueTicket(KEY, FIELDS, NOW);
    expect(ticketHolds(createTicketKey("r".repeat(32)), ticket, FIELDS, NOW)).toBe(false);
    const changed = `${ticket.slice(0, 40)}${ticket[40] === "A" ? "B" : "A"}${ticket.slice(41)}`;
    expect(ticketHolds(KEY, changed, FIELDS, NOW)).toBe(false);
    expect(ticketHolds(KEY, ticket.slice(1), FIELDS, NOW)).toBe(false);
    expect(ticketHolds(KEY, `${ticket}A`, FIELDS, NOW)).toBe(false);
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const last = ticket.at(-1) ?? "A";
    const sibling = alphabet[alphabet.indexOf(last) ^ 1] ?? "A";
    expect(ticketHolds(KEY, `${ticket.slice(0, -1)}${sibling}`, FIELDS, NOW)).toBe(false);
    const wrongFormat = Buffer.from(ticket, "base64url");
    wrongFormat[0] = 0x02;
    expect(ticketHolds(KEY, wrongFormat.toString("base64url"), FIELDS, NOW)).toBe(false);
  });

  it("refuses to issue for a value that is not an id", () => {
    expect(() => issueTicket(KEY, { ...FIELDS, tagId: "x" }, NOW)).toThrow(/Not an id/);
  });
});
