import { describe, expect, it } from "vitest";
import { isPromoSmsAllowed, promoSendTime } from "#src/marketing/send-window";

/** A moment given as Riyadh wall-clock time (UTC+3 all year). */
const riyadh = (iso: string): Date => new Date(`${iso}+03:00`);

// 2026-10-27 is an ordinary day; 2027-02-08 is 1 Ramadan 1448 and 2027-03-08 its 29th (Umm al-Qura).
const ORDINARY = "2026-10-27";
const RAMADAN_MIDDLE = "2027-02-20";

describe("isPromoSmsAllowed outside Ramadan", () => {
  it.each([
    ["09:00:00", true],
    ["08:59:59", false],
    ["12:00:00", true],
    ["21:59:59", true],
    ["22:00:00", false],
    ["23:30:00", false],
    ["00:00:00", false],
    ["03:00:00", false],
  ])("at %s the answer is %s", (time, allowed) => {
    expect(isPromoSmsAllowed(riyadh(`${ORDINARY}T${time}`))).toBe(allowed);
  });
});

describe("isPromoSmsAllowed in the middle of Ramadan", () => {
  it.each([
    ["00:59:59", true],
    ["01:00:00", false],
    ["09:30:00", false],
    ["11:59:59", false],
    ["12:00:00", true],
    ["22:30:00", true],
    ["23:59:59", true],
  ])("at %s the answer is %s", (time, allowed) => {
    expect(isPromoSmsAllowed(riyadh(`${RAMADAN_MIDDLE}T${time}`))).toBe(allowed);
  });
});

describe("isPromoSmsAllowed beside Ramadan's edges, where the sighting may differ by a day", () => {
  it.each(["2027-02-07", "2027-02-08", "2027-03-08", "2027-03-09"])(
    "on %s both windows apply: nothing from 22:00 to 12:00",
    (day) => {
      for (const time of ["00:30:00", "08:59:59", "11:59:59", "22:00:00", "23:59:59"]) {
        expect(isPromoSmsAllowed(riyadh(`${day}T${time}`)), `${day} ${time}`).toBe(false);
      }
      expect(isPromoSmsAllowed(riyadh(`${day}T12:00:00`)), day).toBe(true);
      expect(isPromoSmsAllowed(riyadh(`${day}T18:00:00`)), day).toBe(true);
    },
  );

  it("is back to the ordinary window two days outside Ramadan", () => {
    expect(isPromoSmsAllowed(riyadh("2027-02-06T09:00:00"))).toBe(true);
    expect(isPromoSmsAllowed(riyadh("2027-03-10T09:00:00"))).toBe(true);
  });
});

describe("the Riyadh day boundary", () => {
  it("reads the local hour, not the UTC one", () => {
    expect(isPromoSmsAllowed(new Date("2026-10-27T05:59:59Z"))).toBe(false);
    expect(isPromoSmsAllowed(new Date("2026-10-27T06:00:00Z"))).toBe(true);
    expect(isPromoSmsAllowed(new Date("2026-10-27T18:59:59Z"))).toBe(true);
    expect(isPromoSmsAllowed(new Date("2026-10-27T19:00:00Z"))).toBe(false);
  });
});

describe("promoSendTime", () => {
  it("leaves an allowed SMS time alone", () => {
    const at = riyadh(`${ORDINARY}T15:20:00`);
    expect(promoSendTime("sms", at)).toBe(at);
  });

  it("moves an SMS scheduled for 23:00 to 09:00 the next morning", () => {
    expect(promoSendTime("sms", riyadh(`${ORDINARY}T23:00:00`))).toEqual(
      riyadh("2026-10-28T09:00:00"),
    );
  });

  it("moves an SMS scheduled for the small hours to 09:00 the same day", () => {
    expect(promoSendTime("sms", riyadh(`${ORDINARY}T03:15:00`))).toEqual(
      riyadh(`${ORDINARY}T09:00:00`),
    );
    expect(promoSendTime("sms", riyadh(`${ORDINARY}T08:59:59`))).toEqual(
      riyadh(`${ORDINARY}T09:00:00`),
    );
  });

  it("moves a Ramadan SMS to noon", () => {
    expect(promoSendTime("sms", riyadh(`${RAMADAN_MIDDLE}T01:00:00`))).toEqual(
      riyadh(`${RAMADAN_MIDDLE}T12:00:00`),
    );
    expect(promoSendTime("sms", riyadh(`${RAMADAN_MIDDLE}T10:10:00`))).toEqual(
      riyadh(`${RAMADAN_MIDDLE}T12:00:00`),
    );
  });

  it("keeps a Ramadan night but moves the night before Ramadan's first morning to noon, not 09:00", () => {
    expect(promoSendTime("sms", riyadh("2027-02-19T23:00:00"))).toEqual(
      riyadh("2027-02-19T23:00:00"),
    );
    expect(promoSendTime("sms", riyadh("2027-02-07T23:00:00"))).toEqual(
      riyadh("2027-02-08T12:00:00"),
    );
  });

  it("holds push and email to no window (ADR-065)", () => {
    const night = riyadh(`${ORDINARY}T03:00:00`);
    expect(promoSendTime("push", night)).toBe(night);
    expect(promoSendTime("email", night)).toBe(night);
  });
});
