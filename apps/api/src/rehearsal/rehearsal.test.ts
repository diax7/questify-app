import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  REHEARSAL_ALPHABET,
  cardOf,
  countsOf,
  isOpen,
  newRehearsalCode,
  rehearsalCodeOf,
  rehearsalRefusalOf,
  testCode,
  type CardRow,
} from "#src/rehearsal/rehearsal";

const ROW: CardRow = {
  code: "ABCD-2345",
  status_now: "draft",
  accounts: 2,
  completions: 3,
  points: "45",
  reservations: 1,
  flags: 0,
  first_play_at: new Date("2026-10-23T10:00:00Z"),
  erased_at: null,
  erase_counts: null,
  live_wiped_at: null,
};

describe("newRehearsalCode", () => {
  it("makes XXXX-XXXX from the alphabet, each place from its own pick", () => {
    const picks = [0, 1, 2, 3, 28, 29, 30, 31];
    expect(newRehearsalCode(() => picks.shift() ?? 0)).toBe("ABCD-6789");
  });

  it("asks for a pick below the alphabet's length, and never repeats a fixed code", () => {
    const bounds: number[] = [];
    newRehearsalCode((bound) => {
      bounds.push(bound);
      return 0;
    });
    expect(bounds).toEqual(Array.from({ length: 8 }, () => REHEARSAL_ALPHABET.length));
    expect(REHEARSAL_ALPHABET).not.toMatch(/[IO01]/);
    expect(rehearsalCodeOf(newRehearsalCode())).toBeDefined();
  });
});

describe("rehearsalCodeOf", () => {
  it("accepts the shape in any case, trimmed", () => {
    expect(rehearsalCodeOf(" abcd-2345 ")).toBe("ABCD-2345");
  });

  it("refuses a join code, a missing hyphen, ambiguous letters and extra characters", () => {
    for (const raw of [
      "NAJD1",
      "ABCD2345",
      "ABCD-234O",
      "ABCD-2341",
      "XABCD-2345",
      "ABCD-23456",
      "",
    ]) {
      expect(rehearsalCodeOf(raw)).toBeUndefined();
    }
  });
});

describe("testCode", () => {
  it("is TEST- and the first 8 of the id's md5, in capitals, the same every time", () => {
    const id = "3f1d1c2e-3c55-4a0e-9a8d-1b2c3d4e5f60";
    const md5 = createHash("md5").update(id).digest("hex");
    expect(testCode(id)).toBe(`TEST-${md5.slice(0, 8).toUpperCase()}`);
    expect(testCode(id)).toBe(testCode(id));
    expect(testCode(id)).not.toBe(testCode("another"));
  });
});

describe("rehearsalRefusalOf", () => {
  it("maps the definers' codes and leaves anything else", () => {
    expect(rehearsalRefusalOf({ code: "AN404" })).toBe("not_found");
    expect(rehearsalRefusalOf({ code: "RR409" })).toBe("over");
    expect(rehearsalRefusalOf({ code: "RR404" })).toBe("not_opened");
    expect(rehearsalRefusalOf({ code: "23505" })).toBeUndefined();
    expect(rehearsalRefusalOf({ code: 404 })).toBeUndefined();
    expect(rehearsalRefusalOf({ code: "toString" })).toBeUndefined();
    expect(rehearsalRefusalOf(null)).toBeUndefined();
  });
});

describe("countsOf", () => {
  it("reads each count as a number, a missing or odd one as 0", () => {
    expect(
      countsOf({ accounts: 2, completions: "3", points: 40, reservations: 1, flags: "x" }),
    ).toEqual({
      accounts: 2,
      completions: 3,
      points: 40,
      reservations: 1,
      flags: 0,
    });
    expect(countsOf({})).toEqual({
      accounts: 0,
      completions: 0,
      points: 0,
      reservations: 0,
      flags: 0,
    });
  });
});

describe("isOpen and cardOf", () => {
  it("is open for a Draft or Scheduled event not wiped at go-live", () => {
    expect(isOpen(ROW)).toBe(true);
    expect(isOpen({ ...ROW, status_now: "scheduled" })).toBe(true);
    for (const status of ["live", "ended", "archived"]) {
      expect(isOpen({ ...ROW, status_now: status })).toBe(false);
    }
    expect(isOpen({ ...ROW, live_wiped_at: new Date() })).toBe(false);
  });

  it("shows the code while open, the counts now and the last erase", () => {
    expect(cardOf(ROW)).toEqual({
      code: "ABCD-2345",
      open: true,
      cap: 25,
      now: { accounts: 2, completions: 3, points: 45, reservations: 1, flags: 0 },
      firstPlayAt: "2026-10-23T10:00:00.000Z",
      erasedAt: null,
      erased: null,
      wipedAtGoLive: null,
    });
    const wiped = new Date("2026-10-24T08:00:00Z");
    expect(
      cardOf({
        ...ROW,
        status_now: "live",
        first_play_at: null,
        erased_at: wiped,
        live_wiped_at: wiped,
        erase_counts: { accounts: 2, completions: 3, points: 45, reservations: 1, flags: 1 },
      }),
    ).toMatchObject({
      code: null,
      open: false,
      firstPlayAt: null,
      erasedAt: wiped.toISOString(),
      erased: { flags: 1 },
      wipedAtGoLive: wiped.toISOString(),
    });
  });
});
