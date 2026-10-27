import { describe, expect, it } from "vitest";
import {
  addClosedDay,
  bodyOf,
  dayAfter,
  draftOf,
  hasStarted,
  isolatedDay,
  previewOf,
  refusalOf,
  removeClosedDay,
  settingsOf,
  toggleWeekday,
  type StreakDraft,
} from "#src/lib/streak.ts";

const SETTINGS = {
  enabled: true,
  bonusPoints: 25,
  closedWeekdays: [5],
  closedDays: ["2030-11-02"],
  multiDay: true,
  today: "2030-11-01",
};
const draft = (fields: Partial<StreakDraft> = {}): StreakDraft => ({
  ...draftOf(SETTINGS),
  ...fields,
});

describe("settingsOf and draftOf", () => {
  it("reads the settings in an answer, and nothing from another shape", () => {
    expect(settingsOf({ streak: SETTINGS })).toEqual(SETTINGS);
    expect(settingsOf({ streak: { ...SETTINGS, bonusPoints: null } })?.bonusPoints).toBeNull();
    expect(settingsOf({ streak: { ...SETTINGS, today: "tomorrow" } })).toBeUndefined();
    expect(settingsOf({})).toBeUndefined();
    expect(settingsOf(null)).toBeUndefined();
    expect(settingsOf(undefined)).toBeUndefined();
  });

  it("holds the bonus as typed, empty for none", () => {
    expect(draftOf(SETTINGS)).toEqual({
      enabled: true,
      bonus: "25",
      closedWeekdays: [5],
      closedDays: ["2030-11-02"],
    });
    expect(draftOf({ ...SETTINGS, bonusPoints: null }).bonus).toBe("");
  });
});

describe("bodyOf", () => {
  it("builds the whole body, an empty bonus as null and the weekdays in order", () => {
    expect(bodyOf(draft({ bonus: "", closedWeekdays: [6, 5] }))).toEqual({
      ok: true,
      body: {
        enabled: true,
        bonusPoints: null,
        closedWeekdays: [5, 6],
        closedDays: ["2030-11-02"],
      },
    });
    expect(bodyOf(draft({ bonus: " 100000 " }))).toMatchObject({
      ok: true,
      body: { bonusPoints: 100000 },
    });
  });

  it.each(["0", "-5", "1.5", "abc", "100001", "1e3", "٣"])("refuses the bonus %j", (bonus) => {
    expect(bodyOf(draft({ bonus }))).toEqual({ ok: false, field: "bonusPoints" });
  });

  it("refuses seven closed weekdays, a repeated weekday and a malformed date", () => {
    expect(bodyOf(draft({ closedWeekdays: [1, 2, 3, 4, 5, 6, 7] }))).toEqual({
      ok: false,
      field: "closedWeekdays",
    });
    expect(bodyOf(draft({ closedWeekdays: [5, 5] }))).toEqual({
      ok: false,
      field: "closedWeekdays",
    });
    expect(bodyOf(draft({ closedDays: ["02/11/2030"] }))).toEqual({
      ok: false,
      field: "closedDays",
    });
  });

  it("accepts six closed weekdays, the most", () => {
    expect(bodyOf(draft({ closedWeekdays: [1, 2, 3, 4, 5, 6] })).ok).toBe(true);
  });
});

describe("the closed days", () => {
  it("toggles a weekday on and off, kept in order", () => {
    expect(toggleWeekday(draft({ closedWeekdays: [5] }), 2).closedWeekdays).toEqual([2, 5]);
    expect(toggleWeekday(draft({ closedWeekdays: [2, 5] }), 5).closedWeekdays).toEqual([2]);
  });

  it("adds only an upcoming day that is not there yet, and keeps the dates sorted", () => {
    const base = draft({ closedDays: ["2030-11-05"] });
    expect(addClosedDay(base, "2030-11-03", "2030-11-01")?.closedDays).toEqual([
      "2030-11-03",
      "2030-11-05",
    ]);
    expect(addClosedDay(base, "2030-11-01", "2030-11-01")).toBeUndefined();
    expect(addClosedDay(base, "2030-10-30", "2030-11-01")).toBeUndefined();
    expect(addClosedDay(base, "2030-11-05", "2030-11-01")).toBeUndefined();
    expect(addClosedDay(base, "", "2030-11-01")).toBeUndefined();
    expect(addClosedDay(base, "soon", "2030-11-01")).toBeUndefined();
  });

  it("removes a date, knows which have started and finds the next day across a month end", () => {
    expect(
      removeClosedDay(draft({ closedDays: ["2030-11-02", "2030-11-03"] }), "2030-11-02"),
    ).toMatchObject({
      closedDays: ["2030-11-03"],
    });
    expect(hasStarted("2030-11-01", "2030-11-01")).toBe(true);
    expect(hasStarted("2030-11-02", "2030-11-01")).toBe(false);
    expect(dayAfter("2030-11-30")).toBe("2030-12-01");
    expect(dayAfter("2030-12-31")).toBe("2031-01-01");
    expect(dayAfter("2028-02-28")).toBe("2028-02-29");
  });
});

const conflict = (reason: string, day?: string) => ({
  code: "streak_conflict",
  message: { ar: "x", en: "x" },
  details: day === undefined ? { reason } : { reason, day },
});

describe("refusalOf", () => {
  it("says each conflict by its reason, and the day a started day names", () => {
    expect(refusalOf(conflict("single_day"))).toEqual({ key: "events.streak.refuse.singleDay" });
    expect(refusalOf(conflict("results_final"))).toEqual({
      key: "events.streak.refuse.resultsFinal",
    });
    expect(refusalOf(conflict("archived"))).toEqual({ key: "events.streak.refuse.archived" });
    expect(refusalOf(conflict("day_started", "2030-11-01"))).toEqual({
      key: "events.streak.refuse.dayStarted",
      day: "2030-11-01",
    });
  });

  it("says each invalid field", () => {
    for (const field of ["bonusPoints", "closedWeekdays", "closedDays", "enabled"] as const) {
      expect(refusalOf({ code: "invalid_streak", details: { field } })?.key).toBe(
        `events.streak.invalid.${field}`,
      );
    }
  });

  it("says nothing for another answer, an unknown reason or a body that is not an error", () => {
    expect(refusalOf({ code: "forbidden", details: {} })).toBeUndefined();
    expect(refusalOf(conflict("elsewhere"))).toBeUndefined();
    expect(refusalOf({ code: "invalid_streak", details: { field: "colour" } })).toBeUndefined();
    expect(refusalOf(undefined)).toBeUndefined();
    expect(refusalOf("down")).toBeUndefined();
  });
});

describe("previewOf and isolatedDay", () => {
  it("shows nothing when off, the streak alone with no bonus, and the bonus when there is one", () => {
    expect(previewOf(draft({ enabled: false }))).toEqual({ key: "events.streak.preview.off" });
    expect(previewOf(draft({ bonus: "" }))).toEqual({ key: "events.streak.preview.plain" });
    expect(previewOf(draft({ bonus: "oops" }))).toEqual({ key: "events.streak.preview.plain" });
    expect(previewOf(draft({ bonus: "40" }))).toEqual({
      key: "events.streak.preview.bonus",
      points: 40,
    });
  });

  it("wraps a date as one left-to-right run", () => {
    expect(isolatedDay("2030-11-02")).toBe("⁦2030-11-02⁩");
  });
});
