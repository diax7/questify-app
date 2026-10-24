import { describe, expect, it } from "vitest";
import {
  consoleTicketQuery,
  deviceLine,
  isTicketId,
  readConsoleCounts,
  readConsoleTicket,
  readConsoleTickets,
} from "#src/lib/console-tickets.ts";

const COUNTS = { open: 2, closed: 1, openDirect: 1, openEscalated: 1 };
const ROW = {
  id: "7",
  kind: "app_problem",
  preview: "Blank map",
  status: "open",
  createdAt: "2030-01-01T10:00:00.000Z",
};

describe("the console's Tickets (T-312)", () => {
  it("reads a page and its counts, and refuses anything else", () => {
    expect(readConsoleTickets({ tickets: [ROW], nextCursor: null, counts: COUNTS })).toMatchObject({
      tickets: [ROW],
    });
    expect(
      readConsoleTickets({ tickets: [{ ...ROW, status: "gone" }], counts: COUNTS }),
    ).toBeUndefined();
    expect(readConsoleTickets({ tickets: [ROW], counts: { open: 1 } })).toBeUndefined();
    expect(readConsoleTickets(null)).toBeUndefined();
    expect(readConsoleCounts({ counts: COUNTS })).toEqual(COUNTS);
    expect(readConsoleCounts({ counts: { ...COUNTS, closed: "1" } })).toBeUndefined();
  });

  it("reads one ticket only with its text and status", () => {
    expect(readConsoleTicket({ ticket: { id: "7", text: "Hi", status: "closed" } })).toMatchObject({
      id: "7",
    });
    expect(readConsoleTicket({ ticket: { id: "7", status: "open" } })).toBeUndefined();
    expect(readConsoleTicket({})).toBeUndefined();
  });

  it("asks for a tab, a kind, a source and a cursor, and takes only a ticket id into a path", () => {
    expect(consoleTicketQuery("open", null, null, null)).toBe("?status=open");
    expect(consoleTicketQuery("closed", "suggestion", "direct", "42")).toBe(
      "?status=closed&kind=suggestion&source=direct&cursor=42",
    );
    expect(isTicketId("42")).toBe(true);
    for (const bad of ["0", "-1", "1a", "../x", "1".repeat(19)]) {
      expect(isTicketId(bad), bad).toBe(false);
    }
  });

  it("says the phone facts in one line, the model only when known", () => {
    expect(
      deviceLine({
        appVersion: "1.4.0",
        platform: "ios",
        osVersion: "18.1",
        model: "iPhone 15 Pro",
      }),
    ).toBe("Questify 1.4.0 · iPhone 15 Pro · iOS 18.1");
    expect(
      deviceLine({ appVersion: "1.4.0", platform: "android", osVersion: "34", model: null }),
    ).toBe("Questify 1.4.0 · Android 34");
  });
});
