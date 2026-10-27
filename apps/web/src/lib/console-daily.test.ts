import { describe, expect, it } from "vitest";
import {
  SCHEDULE_DAYS,
  addDays,
  formatDay,
  formatPeriod,
  hasStarted,
  hasWarning,
  questifyDayOf,
  readCadenceChange,
  readDailyConsole,
  readListChange,
  readQuestions,
  readWordListPage,
  refusalOf,
  scheduleRange,
  textIn,
  warningsOf,
} from "#src/lib/console-daily.ts";

const cover = { coveredDays: 14, coveredPeriods: 2, warn: false };
const cadence = { cadence: "weekly", next: null } as const;
const status = {
  challenge: { ...cadence, ...cover },
  word: { ...cadence, ar: cover, en: cover },
};

describe("questifyDayOf", () => {
  it("keeps the 04:00 Riyadh boundary: 03:59 is still yesterday, 04:00 is today", () => {
    expect(questifyDayOf(new Date("2026-10-27T00:59:00Z"))).toBe("2026-10-26");
    expect(questifyDayOf(new Date("2026-10-27T01:00:00Z"))).toBe("2026-10-27");
  });
});

describe("the schedule's days", () => {
  it("moves a day across a month and a year", () => {
    expect(addDays("2026-10-30", 3)).toBe("2026-11-02");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("asks for a range the API accepts (at most 120 days apart), from today", () => {
    const { from, to } = scheduleRange("2026-10-27");
    expect(from).toBe("2026-10-27");
    expect(Date.parse(to) - Date.parse(from)).toBe((SCHEDULE_DAYS - 1) * 86_400_000);
    expect(SCHEDULE_DAYS - 1).toBeLessThanOrEqual(120);
  });

  it("treats a period as started on its first day, not before", () => {
    expect(hasStarted("2026-10-27", "2026-10-27")).toBe(true);
    expect(hasStarted("2026-10-28", "2026-10-27")).toBe(false);
  });
});

describe("formatPeriod", () => {
  it("names one day with its weekday", () => {
    expect(formatDay("2026-10-25", "en")).toBe("Sun 25 Oct 2026");
  });

  it("names a week by its first and last day", () => {
    expect(formatPeriod("2026-10-25", "2026-10-31", "en")).toBe(
      "Sun 25 Oct 2026 - Sat 31 Oct 2026",
    );
    expect(formatPeriod("2026-10-25", "2026-10-25", "en")).toBe("Sun 25 Oct 2026");
  });

  it("uses Western digits and the Gregorian calendar in Arabic", () => {
    const text = formatPeriod("2026-10-25", "2026-10-31", "ar");
    expect(text).toMatch(/25/);
    expect(text).toMatch(/2026/);
    expect(text).not.toMatch(/[٠-٩]/);
  });
});

describe("textIn", () => {
  it("falls back to the other language when one is empty", () => {
    expect(textIn({ ar: "", en: "Hello" }, "ar")).toBe("Hello");
    expect(textIn({ ar: "أهلا", en: "Hello" }, "ar")).toBe("أهلا");
  });
});

describe("readDailyConsole", () => {
  const body = {
    status,
    periods: [
      {
        kind: "challenge",
        startsOn: "2026-10-25",
        endsOn: "2026-10-31",
        challenge: {
          id: 1,
          startsOn: "2026-10-25",
          questions: [
            "6f1c7a0e-0000-4000-8000-000000000001",
            "6f1c7a0e-0000-4000-8000-000000000002",
            "6f1c7a0e-0000-4000-8000-000000000003",
          ],
          sponsor: null,
          finishes: 0,
        },
      },
      { kind: "word", startsOn: "2026-10-25", endsOn: "2026-10-31", words: {} },
      { kind: "challenge", startsOn: "2026-11-01", endsOn: "2026-11-07", challenge: null },
    ],
    unused: [{ kind: "word", language: "ar", startsOn: "2026-10-27" }],
  };

  it("reads the API's answer, with an empty period as null", () => {
    const read = readDailyConsole(body);
    expect(read?.periods).toHaveLength(3);
    expect(read?.periods[2]?.challenge).toBeNull();
  });

  it.each([
    ["nothing", undefined],
    ["a status missing", { ...body, status: undefined }],
    ["an unknown kind", { ...body, periods: [{ ...body.periods[0], kind: "poll" }] }],
  ])("is undefined for %s, so the page shows its error state", (_name, value) => {
    expect(readDailyConsole(value)).toBeUndefined();
  });
});

describe("the other readers", () => {
  it("reads a bank page, a list page, a list change and a cadence change", () => {
    expect(readQuestions({ questions: [] })).toEqual([]);
    expect(readQuestions({ questions: [{ id: "x" }] })).toBeUndefined();
    expect(readWordListPage({ words: ["apple"], total: 1 })).toEqual({
      words: ["apple"],
      total: 1,
    });
    expect(readWordListPage({ words: "apple", total: 1 })).toBeUndefined();
    expect(readListChange({ added: 2, removed: 0, refused: ["ab"], total: 9 })?.refused).toEqual([
      "ab",
    ]);
    expect(readListChange({ added: 2 })).toBeUndefined();
    expect(
      readCadenceChange({ kind: "word", cadence: "daily", from: "2026-10-28", unused: 0 })?.from,
    ).toBe("2026-10-28");
    expect(
      readCadenceChange({ kind: "word", cadence: "daily", unchanged: true, unused: 2 })?.unchanged,
    ).toBe(true);
    expect(readCadenceChange({ kind: "word", cadence: "monthly", unused: 0 })).toBeUndefined();
  });
});

describe("warningsOf", () => {
  it("is quiet while every kind is covered", () => {
    expect(warningsOf(status)).toEqual([]);
    expect(hasWarning(status)).toBe(false);
  });

  it("warns for the challenge and for each word language on its own", () => {
    const low = { coveredDays: 5, coveredPeriods: 1, warn: true };
    const found = warningsOf({
      challenge: { ...cadence, ...low },
      word: { ...cadence, ar: cover, en: low },
    });
    expect(found).toEqual([
      { kind: "challenge", language: null, coveredDays: 5, coveredPeriods: 1 },
      { kind: "word", language: "en", coveredDays: 5, coveredPeriods: 1 },
    ]);
    expect(
      hasWarning({ challenge: { ...cadence, ...cover }, word: { ...cadence, ar: low, en: cover } }),
    ).toBe(true);
  });
});

const conflict = (details: object) => ({ code: "daily_content_conflict", details });
const invalid = (field: string) => ({ code: "invalid_daily", details: { field } });

describe("refusalOf", () => {
  it.each([
    [conflict({ reason: "started" }), "console.daily.conflict.started"],
    [conflict({ reason: "scheduled" }), "console.daily.conflict.scheduled"],
    [conflict({ reason: "retired" }), "console.daily.conflict.retired"],
    [conflict({ reason: "changed" }), "console.daily.conflict.changed"],
    [conflict({ reason: "used", position: 2 }), "console.daily.conflict.usedQuestion"],
    [conflict({ reason: "used" }), "console.daily.conflict.usedWord"],
    [conflict({ reason: "something new" }), "console.daily.conflict.other"],
    [invalid("prompt"), "console.daily.invalid.prompt"],
    [invalid("not_period_start"), "console.daily.invalid.notPeriodStart"],
    [invalid("range"), "console.daily.invalid.other"],
  ])("says %j in words", (body, key) => {
    expect(refusalOf(body)?.key).toBe(key);
  });

  it("names the question at fault", () => {
    expect(refusalOf(conflict({ reason: "used", position: 2 }))?.params).toEqual({ position: 2 });
  });

  it("leaves any other answer to the API's own message", () => {
    expect(refusalOf({ code: "rate_limited" })).toBeUndefined();
    expect(refusalOf(undefined)).toBeUndefined();
  });
});
