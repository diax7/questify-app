import { MESSAGES } from "@questify/shared";
import { describe, expect, it } from "vitest";
import {
  TABS,
  answeredByLine,
  canReply,
  kindKey,
  outcomeKey,
  ticketQuery,
} from "#src/lib/tickets.ts";

describe("the Help desk page (T-310)", () => {
  it("names each kind, outcome and tab in both languages", () => {
    expect(TABS).toEqual(["open", "closed"]);
    for (const kind of ["question", "problem"] as const) {
      expect(MESSAGES[kindKey(kind)].ar).not.toBe("");
    }
    expect(outcomeKey({ status: "open", outcome: null })).toBe("help.status.open");
    expect(outcomeKey({ status: "closed", outcome: "answered" })).toBe("help.status.answered");
    expect(outcomeKey({ status: "closed", outcome: "solved" })).toBe("help.status.solved");
  });

  it("says who answered: an operator's @username, a staff email, or a deleted account", () => {
    expect(answeredByLine({ answeredBy: null, outcome: null }, "en")).toBeNull();
    expect(
      answeredByLine(
        { answeredBy: { kind: "operator", name: "sara", deleted: false }, outcome: "answered" },
        "en",
      ),
    ).toBe("Answered by @sara");
    expect(
      answeredByLine(
        {
          answeredBy: { kind: "staff", name: "owner@najd.test", deleted: false },
          outcome: "solved",
        },
        "en",
      ),
    ).toBe("Closed by owner@najd.test");
    expect(
      answeredByLine(
        { answeredBy: { kind: "operator", name: null, deleted: true }, outcome: "answered" },
        "ar",
      ),
    ).toBe("الرد من حساب محذوف");
  });

  it("needs a reply of 1 to 1000 characters", () => {
    expect(canReply("  ")).toBe(false);
    expect(canReply("Behind hall B")).toBe(true);
    expect(canReply("x".repeat(1000))).toBe(true);
    expect(canReply("x".repeat(1001))).toBe(false);
  });

  it("asks for one tab, one kind or all, from a cursor", () => {
    expect(ticketQuery("open", null, null)).toBe("?status=open");
    expect(ticketQuery("closed", "problem", "42")).toBe("?status=closed&kind=problem&cursor=42");
  });
});
