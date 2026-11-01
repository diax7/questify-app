import { MESSAGES, type Inbox } from "@questify/shared";
import { describe, expect, it } from "vitest";
import {
  INBOX_KINDS,
  helpDeskLink,
  kindTitleKey,
  previewOf,
  waitingTotal,
  whenOf,
  withQuestifyLink,
} from "#src/lib/inbox.ts";
import { filtersFromQuery } from "#src/lib/tickets.ts";

const none: Inbox = {
  tickets: { question: 0, problem: 0, prize: 0, report_player: 0 },
  withQuestify: 0,
  joinRequests: { pending: 0, private: false },
  submissions: 0,
  flags: 0,
};

describe("the Inbox page (T-616)", () => {
  it("names every kind it counts in both languages", () => {
    expect(INBOX_KINDS).toEqual(["question", "problem", "prize", "report_player"]);
    for (const kind of INBOX_KINDS) {
      expect(MESSAGES[kindTitleKey(kind)].en).not.toBe("");
      expect(MESSAGES[kindTitleKey(kind)].ar).not.toBe("");
    }
  });

  it("links each count to the Help desk list it counts, which the Help desk reads back from its address", () => {
    for (const kind of INBOX_KINDS) {
      const link = helpDeskLink("/en/organizers/o/events/e", kind);
      const query = Object.fromEntries(new URL(link, "https://questify.test").searchParams);
      expect(filtersFromQuery(query)).toEqual({ tab: "open", kind });
    }
    const questify = Object.fromEntries(
      new URL(withQuestifyLink("/en/organizers/o/events/e"), "https://questify.test").searchParams,
    );
    expect(filtersFromQuery(questify)).toEqual({ tab: "with_questify", kind: null });
  });

  it("opens the Help desk on Open, all kinds, for anything it does not know", () => {
    expect(filtersFromQuery({})).toEqual({ tab: "open", kind: null });
    expect(filtersFromQuery({ status: "deleted", kind: "app_" })).toEqual({
      tab: "open",
      kind: null,
    });
    expect(filtersFromQuery({ status: "closed", kind: "suggestion" })).toEqual({
      tab: "closed",
      kind: "suggestion",
    });
  });

  it("adds up everything that waits", () => {
    expect(waitingTotal(none)).toBe(0);
    expect(
      waitingTotal({
        tickets: { question: 1, problem: 2, prize: 3, report_player: 4 },
        withQuestify: 5,
        joinRequests: { pending: 6, private: true },
        submissions: 7,
        flags: 8,
      }),
    ).toBe(36);
  });

  it("cuts a request to one line at a space, and says it was cut", () => {
    expect(previewOf("  Where   is\nmy prize? ")).toBe("Where is my prize?");
    expect(previewOf("")).toBe("");
    const long = `${"word ".repeat(30)}end`;
    const cut = previewOf(long);
    expect(cut.endsWith("…")).toBe(true);
    expect(cut.length).toBeLessThanOrEqual(81);
    expect(cut).not.toMatch(/\wwo…$/u);
    expect(previewOf("x".repeat(200))).toBe(`${"x".repeat(80)}…`);
    expect(previewOf("x".repeat(80))).toBe("x".repeat(80));
  });

  it("writes a time as day/month/year and a 24-hour clock, with Western digits and no direction marks", () => {
    const written = whenOf("2026-11-02T09:05:00Z");
    expect(written).toMatch(/^\d{2}\/\d{2}\/2026, \d{2}:\d{2}$/u);
    expect(written).not.toMatch(/[٠-٩۰-۹‎‏؜]/u);
  });
});
