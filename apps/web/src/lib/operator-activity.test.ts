import { MESSAGES, type OperatorActivityRow } from "@questify/shared";
import { describe, expect, it } from "vitest";
import {
  actionKey,
  agoText,
  clockOf,
  isQuiet,
  issueKey,
  minutesQuiet,
  nextRecent,
  summaryOf,
} from "#src/lib/operator-activity.ts";

const AS_OF = "2026-11-02T10:00:00+00:00";
const row = (over: Partial<OperatorActivityRow> = {}): OperatorActivityRow => ({
  id: "7d1c9d3e-5b0a-4c9e-8d31-5a3f6c2b9e11",
  username: "nora",
  scansHour: 0,
  scans: 0,
  awards: 0,
  handOvers: 0,
  handled: 0,
  lastAt: null,
  lastAction: null,
  stations: [],
  ...over,
});
const minutesAgo = (minutes: number): string =>
  new Date(new Date(AS_OF).getTime() - minutes * 60_000).toISOString();

describe("how long an operator has been quiet", () => {
  it("counts whole minutes on the read's own clock, and none for an operator who never acted", () => {
    expect(minutesQuiet(minutesAgo(12), AS_OF)).toBe(12);
    expect(minutesQuiet(minutesAgo(12.9), AS_OF)).toBe(12);
    expect(minutesQuiet(AS_OF, AS_OF)).toBe(0);
    expect(minutesQuiet("2026-11-02T10:00:05+00:00", AS_OF)).toBe(0);
    expect(minutesQuiet(null, AS_OF)).toBeNull();
  });

  it("calls an operator quiet from 30 minutes, and one who never acted quiet too", () => {
    expect(isQuiet(row({ lastAt: minutesAgo(29) }), AS_OF)).toBe(false);
    expect(isQuiet(row({ lastAt: minutesAgo(30) }), AS_OF)).toBe(true);
    expect(isQuiet(row({ lastAt: minutesAgo(45) }), AS_OF)).toBe(true);
    expect(isQuiet(row(), AS_OF)).toBe(true);
  });
});

describe("the tiles", () => {
  it("adds the event's numbers and counts the operators who are not quiet", () => {
    const rows = [
      row({ lastAt: minutesAgo(2), scansHour: 5, scans: 40, awards: 1, handOvers: 2 }),
      row({ lastAt: minutesAgo(31), scansHour: 0, scans: 12, awards: 0, handOvers: 1 }),
      row(),
    ];
    expect(summaryOf(rows, AS_OF)).toEqual({
      active: 1,
      scansHour: 5,
      scans: 52,
      awards: 1,
      handOvers: 3,
    });
    expect(summaryOf([], AS_OF)).toEqual({
      active: 0,
      scansHour: 0,
      scans: 0,
      awards: 0,
      handOvers: 0,
    });
  });
});

describe("the latest-actions steps", () => {
  it("grows 5, 25, 50 and then stops", () => {
    expect(nextRecent(5)).toBe(25);
    expect(nextRecent(25)).toBe(50);
    expect(nextRecent(50)).toBeNull();
    expect(nextRecent(1)).toBe(5);
  });
});

describe("how long ago", () => {
  it("reads in the language with Western digits and the language's own plural", () => {
    expect(agoText(12, "en")).toBe("12 minutes ago");
    expect(agoText(1, "en")).toBe("1 minute ago");
    expect(agoText(0, "en")).toMatch(/now|this minute|0 minutes ago/);
    expect(agoText(125, "en")).toBe("2 hours ago");
    expect(agoText(3 * 1440, "en")).toBe("3 days ago");
    expect(agoText(12, "ar")).toBe("قبل 12 دقيقة");
    expect(agoText(5, "ar")).toBe("قبل 5 دقائق");
    expect(agoText(12, "ar")).toMatch(/^[^٠-٩]*$/);
  });
});

describe("words and clock", () => {
  it("names every action and every issue", () => {
    for (const action of [
      "scan",
      "check_in",
      "award",
      "hand_over",
      "cancel",
      "review",
      "answer",
    ] as const) {
      expect(actionKey(action)).toMatch(/^operatorActivity\.action\.[a-z][a-zA-Z]*$/);
      expect(MESSAGES[actionKey(action)]).toBeDefined();
    }
    expect(issueKey("too_long")).toBe("briefing.issue.tooLong");
    expect(issueKey("looks_like_phone")).toBe("briefing.issue.looksLikePhone");
  });

  it("writes a time of day with Western digits", () => {
    expect(clockOf("2026-11-02T09:05:00Z")).toMatch(/^\d{2}:\d{2}$/);
  });
});
