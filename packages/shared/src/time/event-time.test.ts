import { describe, expect, it } from "vitest";
import {
  eventDayOf,
  formatEventTime,
  formatLocalDate,
  formatLocalMonth,
  formatTimeWindow,
  isTimeZone,
  localParts,
  toInstant,
  toLocalInput,
  zoneLabel,
} from "#src/time/event-time";

const ZONES = [
  "Asia/Riyadh",
  "Asia/Dubai",
  "Europe/London",
  "America/New_York",
  "Asia/Kolkata",
  "UTC",
];

describe("toInstant and toLocalInput", () => {
  it("reads a wall-clock time in the event's zone, not the machine's", () => {
    expect(toInstant("2026-10-23T09:00", "Asia/Riyadh").toISOString()).toBe(
      "2026-10-23T06:00:00.000Z",
    );
    expect(toInstant("2026-10-23T09:00", "Asia/Dubai").toISOString()).toBe(
      "2026-10-23T05:00:00.000Z",
    );
    expect(toInstant("2026-10-23T09:30", "Asia/Kolkata").toISOString()).toBe(
      "2026-10-23T04:00:00.000Z",
    );
    expect(toLocalInput(new Date("2026-10-23T06:00:00Z"), "Asia/Riyadh")).toBe("2026-10-23T09:00");
  });

  it("moves a time skipped by a clock change forward, and takes the earlier of a repeated one", () => {
    // London: 01:00 becomes 02:00 on 29 March 2026; 02:00 becomes 01:00 on 25 October 2026.
    expect(toLocalInput(toInstant("2026-03-29T01:30", "Europe/London"), "Europe/London")).toBe(
      "2026-03-29T02:30",
    );
    expect(toInstant("2026-10-25T01:30", "Europe/London").toISOString()).toBe(
      "2026-10-25T00:30:00.000Z",
    );
  });

  it("round-trips every fifth hour of a year in each zone, apart from the skipped ones", () => {
    for (const zone of ZONES) {
      for (let hour = 0; hour < 365 * 24; hour += 5) {
        const instant = new Date(Date.UTC(2026, 0, 1) + hour * 3_600_000);
        const local = toLocalInput(instant, zone);
        const back = toInstant(local, zone);
        expect(toLocalInput(back, zone), `${zone} ${local}`).toBe(local);
        // The earlier of two readings, so never later than the instant we started from.
        expect(back.getTime(), `${zone} ${local}`).toBeLessThanOrEqual(instant.getTime());
      }
    }
  });

  it.each([
    ["not a date", "Asia/Riyadh"],
    ["2026-10-23 09:00", "Asia/Riyadh"],
    ["2026-10-23T09:00", "Mars/Olympus"],
    ["2026-10-23T09:00", ""],
    ["2030-02-30T09:00", "Asia/Riyadh"],
    ["2031-02-29T09:00", "Asia/Riyadh"],
    ["2026-13-01T09:00", "Asia/Riyadh"],
    ["2026-10-23T24:00", "Asia/Riyadh"],
    ["2026-10-23T09:60", "Asia/Riyadh"],
  ])("refuses %j in %j", (local, zone) => {
    expect(() => toInstant(local, zone)).toThrow(RangeError);
  });

  it("accepts the 29th of February in a leap year", () => {
    expect(toInstant("2028-02-29T09:00", "UTC").toISOString()).toBe("2028-02-29T09:00:00.000Z");
  });
});

describe("isTimeZone", () => {
  it("knows the IANA zones and nothing else", () => {
    expect(isTimeZone("Asia/Riyadh")).toBe(true);
    expect(isTimeZone("UTC")).toBe(true);
    expect(isTimeZone("Asia/Nowhere")).toBe(false);
    expect(isTimeZone("")).toBe(false);
    expect(isTimeZone("Asia/Riyadh ")).toBe(false);
  });

  it("refuses offsets, abbreviations, case variants and unknown names", () => {
    for (const name of ["asia/riyadh", "ASIA/RIYADH", "+03:00", "EST", "Asia/Nowhere", "Asia/"]) {
      expect(isTimeZone(name), name).toBe(false);
    }
  });

  it("accepts current IANA names even where the runtime still calls them by an older alias", () => {
    for (const name of [
      "Asia/Kolkata",
      "America/Argentina/Buenos_Aires",
      "Europe/Kyiv",
      "US/Pacific",
    ]) {
      expect(isTimeZone(name), name).toBe(true);
    }
  });
});

const at = (local: string): Date => toInstant(local, "Asia/Riyadh");

describe("eventDayOf", () => {
  it("counts a time before the day-start hour toward the previous day (FR-1714)", () => {
    expect(eventDayOf(at("2026-10-24T01:00"), "Asia/Riyadh", 4)).toBe("2026-10-23");
    expect(eventDayOf(at("2026-10-24T03:59"), "Asia/Riyadh", 4)).toBe("2026-10-23");
    expect(eventDayOf(at("2026-10-24T04:00"), "Asia/Riyadh", 4)).toBe("2026-10-24");
    expect(eventDayOf(at("2026-10-24T23:59"), "Asia/Riyadh", 4)).toBe("2026-10-24");
    expect(eventDayOf(at("2026-10-24T05:59"), "Asia/Riyadh", 6)).toBe("2026-10-23");
  });

  it("is the plain calendar date with a midnight start, and crosses months and years", () => {
    expect(eventDayOf(toInstant("2026-11-01T00:00", "Asia/Riyadh"), "Asia/Riyadh", 0)).toBe(
      "2026-11-01",
    );
    expect(eventDayOf(toInstant("2027-01-01T02:00", "Asia/Riyadh"), "Asia/Riyadh", 4)).toBe(
      "2026-12-31",
    );
    expect(eventDayOf(toInstant("2026-03-01T02:00", "Asia/Riyadh"), "Asia/Riyadh", 4)).toBe(
      "2026-02-28",
    );
  });

  it("reads the day in the event's zone: the same instant is two different days in two zones", () => {
    const instant = new Date("2026-10-24T22:30:00Z");
    expect(eventDayOf(instant, "Asia/Riyadh", 0)).toBe("2026-10-25");
    expect(eventDayOf(instant, "America/New_York", 0)).toBe("2026-10-24");
  });
});

describe("zoneLabel and formatEventTime", () => {
  it("names the zone in each language", () => {
    expect(zoneLabel("Asia/Riyadh", "ar")).toBe("بتوقيت الرياض");
    expect(zoneLabel("Asia/Riyadh", "en")).toBe("Riyadh time");
    expect(zoneLabel("America/New_York", "en")).toBe("New York time");
    expect(zoneLabel("UTC", "ar")).toBe("بتوقيت UTC");
  });

  it("shows the date and a 24-hour time in the event's zone, with Western digits and a Gregorian date", () => {
    const instant = new Date("2026-10-23T06:00:00Z");
    const en = formatEventTime(instant, "Asia/Riyadh", "en");
    expect(en).toContain("09:00");
    expect(en).toContain("23 Oct 2026");
    expect(en.endsWith("(Riyadh time)")).toBe(true);
    const ar = formatEventTime(instant, "Asia/Riyadh", "ar");
    expect(ar).toContain("09:00");
    expect(ar).toContain("2026");
    expect(ar).not.toMatch(/[٠-٩]/);
    expect(ar.endsWith("(بتوقيت الرياض)")).toBe(true);
    expect(formatEventTime(instant, "Asia/Dubai", "en")).toContain("10:00");
  });

  it("reads parts with a 24-hour clock, so midnight is hour 0", () => {
    expect(localParts(new Date("2026-10-23T21:00:00Z"), "Asia/Riyadh")).toEqual({
      year: 2026,
      month: 10,
      day: 24,
      hour: 0,
      minute: 0,
    });
  });
});

describe("zoneLabel", () => {
  it.each([
    ["Asia/Riyadh", "بتوقيت الرياض", "Riyadh time"],
    ["Asia/Dubai", "بتوقيت دبي", "Dubai time"],
    ["Asia/Kuwait", "بتوقيت الكويت", "Kuwait time"],
    ["Asia/Qatar", "بتوقيت الدوحة", "Doha time"],
    ["Asia/Bahrain", "بتوقيت البحرين", "Bahrain time"],
    ["Asia/Muscat", "بتوقيت مسقط", "Muscat time"],
    ["Africa/Cairo", "بتوقيت القاهرة", "Cairo time"],
    ["Asia/Amman", "بتوقيت عمّان", "Amman time"],
    ["America/Argentina/Buenos_Aires", "بتوقيت Buenos Aires", "Buenos Aires time"],
    ["UTC", "بتوقيت UTC", "UTC time"],
  ])("names %s", (zone, ar, en) => {
    expect(zoneLabel(zone, "ar")).toBe(ar);
    expect(zoneLabel(zone, "en")).toBe(en);
  });
});

describe("localParts", () => {
  it("reads the wall clock in the zone", () => {
    expect(localParts(new Date("2030-11-01T21:30:00Z"), "Asia/Riyadh")).toEqual({
      year: 2030,
      month: 11,
      day: 2,
      hour: 0,
      minute: 30,
    });
  });

  it("refuses a zone that is not one", () => {
    expect(() => localParts(new Date(), "asia/riyadh")).toThrow(RangeError);
  });
});

describe("formatTimeWindow", () => {
  it("shows one date for a window inside a day, in the event's zone, the zone named once", () => {
    const opens = new Date("2026-10-23T13:00:00Z");
    const closes = new Date("2026-10-23T19:00:00Z");
    const en = formatTimeWindow(opens, closes, "Asia/Riyadh", "en");
    expect(en).toBe("Fri 23 Oct, 16:00–22:00 (Riyadh time)");
    const ar = formatTimeWindow(opens, closes, "Asia/Riyadh", "ar");
    expect(ar).toContain("16:00–22:00");
    expect(ar).toContain("، ");
    expect(ar).not.toMatch(/[٠-٩]/);
    expect(ar.endsWith("(بتوقيت الرياض)")).toBe(true);
  });

  it("shows both dates when the window runs past midnight", () => {
    const en = formatTimeWindow(
      new Date("2026-10-23T19:00:00Z"),
      new Date("2026-10-23T23:00:00Z"),
      "Asia/Riyadh",
      "en",
    );
    expect(en).toBe("Fri 23 Oct, 22:00 – Sat 24 Oct, 02:00 (Riyadh time)");
  });
});

describe("formatLocalDate", () => {
  it("shows a local date as day, month and year with Western digits in both languages", () => {
    expect(formatLocalDate("2026-10-26", "en")).toBe("26 Oct 2026");
    expect(formatLocalDate("2026-10-26", "ar")).toMatch(/^26 .+ 2026$/);
    expect(formatLocalDate("2026-10-26", "ar")).not.toMatch(/[٠-٩]/);
  });

  it("never moves the day, whatever the machine's zone", () => {
    expect(formatLocalDate("2026-01-01", "en")).toBe("1 Jan 2026");
    expect(formatLocalDate("2026-12-31", "en")).toBe("31 Dec 2026");
  });
});

describe("formatLocalMonth", () => {
  it("names a month and its year with Western digits in both languages", () => {
    expect(formatLocalMonth("2026-10", "en")).toBe("October 2026");
    expect(formatLocalMonth("2026-10", "ar")).toMatch(/^.+ 2026$/);
    expect(formatLocalMonth("2026-10", "ar")).not.toMatch(/[٠-٩]/);
  });

  it("never moves the month, whatever the machine's zone", () => {
    expect(formatLocalMonth("2026-01", "en")).toBe("January 2026");
    expect(formatLocalMonth("2026-12", "en")).toBe("December 2026");
  });
});
