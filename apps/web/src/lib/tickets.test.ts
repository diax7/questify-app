import { MESSAGES } from "@questify/shared";
import { describe, expect, it } from "vitest";
import {
  TABS,
  TAB_KEYS,
  answeredByLine,
  canReply,
  kindKey,
  outcomeKey,
  reportedLine,
  tabCount,
  ticketQuery,
} from "#src/lib/tickets.ts";

describe("the Help desk page (T-310)", () => {
  it("names each kind, outcome and tab in both languages", () => {
    expect(TABS).toEqual(["open", "with_questify", "closed"]);
    for (const tab of TABS) {
      expect(MESSAGES[TAB_KEYS[tab]].en).toContain("{count}");
    }
    const kinds = [
      "question",
      "problem",
      "prize",
      "report_player",
      "app_problem",
      "suggestion",
    ] as const;
    for (const kind of kinds) {
      expect(MESSAGES[kindKey(kind)].ar).not.toBe("");
    }
    expect(new Set(kinds.map(kindKey)).size).toBe(6);
    const counts = { open: 1, withQuestify: 2, closed: 3, waitingByKind: {} };
    expect(TABS.map((tab) => tabCount(counts, tab))).toEqual([1, 2, 3]);
    expect(tabCount(null, "open")).toBe(0);
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
    expect(
      answeredByLine(
        { answeredBy: { kind: "admin", name: null, deleted: false }, outcome: "answered" },
        "en",
      ),
    ).toBe("Answered by the Questify team");
    expect(
      answeredByLine(
        { answeredBy: { kind: "admin", name: null, deleted: false }, outcome: "solved" },
        "en",
      ),
    ).toBe("Closed by the Questify team");
  });

  it("names the reported member, or a deleted account (T-312)", () => {
    expect(reportedLine({ reported: null }, "en")).toBeNull();
    expect(reportedLine({ reported: { enrollmentId: "e", username: "khalid" } }, "en")).toBe(
      "Reported: @khalid",
    );
    expect(reportedLine({ reported: { enrollmentId: "e", username: null } }, "ar")).toBe(
      "البلاغ عن: حساب محذوف",
    );
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
    expect(ticketQuery("with_questify", null, null)).toBe("?status=with_questify");
  });
});
