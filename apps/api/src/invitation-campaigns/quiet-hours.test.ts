import { describe, expect, it } from "vitest";
import {
  invitationSmsAllowed,
  invitationSmsClaimable,
  invitationSmsTime,
} from "#src/invitation-campaigns/quiet-hours";

/** A moment given as Riyadh wall-clock time (UTC+3 all year). */
const riyadh = (iso: string): Date => new Date(`${iso}+03:00`);

// 2026-10-27 is an ordinary day; 2027-02-08 is 1 Ramadan 1448 and 2027-03-08 its 29th (Umm al-Qura).
const ORDINARY = "2026-10-27";
const RAMADAN_MIDDLE = "2027-02-20";

describe("invitationSmsAllowed outside Ramadan (the fixed band, 22:00 to 09:00)", () => {
  it.each([
    ["08:59:59", false],
    ["09:00:00", true],
    ["12:00:00", true],
    ["21:59:59", true],
    ["22:00:00", false],
    ["00:00:00", false],
    ["05:00:00", false],
  ])("at %s the answer is %s", (time, allowed) => {
    expect(invitationSmsAllowed(riyadh(`${ORDINARY}T${time}`))).toBe(allowed);
  });
});

describe("invitationSmsAllowed in Ramadan: both bands, so nothing from 22:00 to 12:00", () => {
  it.each([
    ["21:59:59", true],
    ["22:00:00", false],
    ["23:59:59", false],
    ["00:30:00", false],
    ["09:00:00", false],
    ["11:59:59", false],
    ["12:00:00", true],
    ["18:00:00", true],
  ])("at %s the answer is %s", (time, allowed) => {
    expect(invitationSmsAllowed(riyadh(`${RAMADAN_MIDDLE}T${time}`))).toBe(allowed);
  });

  it.each(["2027-02-07", "2027-02-08", "2027-03-08", "2027-03-09"])(
    "on the edge day %s too",
    (day) => {
      expect(invitationSmsAllowed(riyadh(`${day}T09:30:00`))).toBe(false);
      expect(invitationSmsAllowed(riyadh(`${day}T22:30:00`))).toBe(false);
      expect(invitationSmsAllowed(riyadh(`${day}T12:00:00`))).toBe(true);
    },
  );
});

describe("invitationSmsClaimable (the 60-second lease margin)", () => {
  it.each([
    ["21:58:59", true],
    ["21:59:00", false],
    ["21:59:30", false],
    ["08:59:00", false],
    ["09:00:00", true],
  ])("at %s the tick may claim: %s", (time, claimable) => {
    expect(invitationSmsClaimable(riyadh(`${ORDINARY}T${time}`))).toBe(claimable);
  });
});

describe("invitationSmsTime", () => {
  it("keeps an allowed time as it is", () => {
    const at = riyadh(`${ORDINARY}T14:37:12`);
    expect(invitationSmsTime(at)).toEqual(at);
  });

  it.each([
    [`${ORDINARY}T22:15:00`, "2026-10-28T09:00:00"],
    [`${ORDINARY}T03:00:00`, `${ORDINARY}T09:00:00`],
    [`${ORDINARY}T08:59:59`, `${ORDINARY}T09:00:00`],
    [`${RAMADAN_MIDDLE}T22:15:00`, "2027-02-21T12:00:00"],
    [`${RAMADAN_MIDDLE}T09:30:00`, `${RAMADAN_MIDDLE}T12:00:00`],
  ])("moves %s to %s", (from, to) => {
    expect(invitationSmsTime(riyadh(from))).toEqual(riyadh(to));
  });
});
