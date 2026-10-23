import { describe, expect, it } from "vitest";
import { erasedLine, holdsData, readRehearsal, type RehearsalView } from "#src/lib/rehearsal.ts";

const EMPTY = { accounts: 0, completions: 0, points: 0, reservations: 0, flags: 0 };
const VIEW: RehearsalView = {
  code: "ABCD-2345",
  open: true,
  cap: 25,
  now: EMPTY,
  firstPlayAt: null,
  erasedAt: null,
  erased: null,
  wipedAtGoLive: null,
};

describe("readRehearsal", () => {
  it("reads the card", () => {
    expect(readRehearsal(VIEW)).toEqual(VIEW);
    expect(
      readRehearsal({ ...VIEW, code: null, open: false, erased: { ...EMPTY, accounts: 2 } }),
    ).toBeDefined();
  });

  it("refuses another shape, field by field", () => {
    for (const broken of [
      null,
      "card",
      { ...VIEW, code: 1 },
      { ...VIEW, open: "yes" },
      { ...VIEW, cap: "25" },
      { ...VIEW, now: { ...EMPTY, flags: "0" } },
      { ...VIEW, now: null },
      { ...VIEW, firstPlayAt: 1 },
      { ...VIEW, erasedAt: 1 },
      { ...VIEW, erased: { accounts: 1 } },
      { ...VIEW, wipedAtGoLive: 1 },
    ]) {
      expect(readRehearsal(broken)).toBeUndefined();
    }
  });
});

describe("holdsData", () => {
  it("is false only when every count is zero", () => {
    expect(holdsData(EMPTY)).toBe(false);
    for (const key of ["accounts", "completions", "points", "reservations", "flags"] as const) {
      expect(holdsData({ ...EMPTY, [key]: 1 })).toBe(true);
    }
  });
});

describe("erasedLine", () => {
  it("says nothing before any erase, the team's erase, or the go-live wipe", () => {
    expect(erasedLine(VIEW)).toBeUndefined();
    const erased = { ...EMPTY, accounts: 3, completions: 7, reservations: 2 };
    expect(erasedLine({ ...VIEW, erased })).toEqual({
      key: "rehearsal.erased",
      params: { accounts: 3, completions: 7, reservations: 2 },
    });
    expect(erasedLine({ ...VIEW, erased, wipedAtGoLive: "2026-10-24T08:00:00Z" })?.key).toBe(
      "rehearsal.wiped",
    );
  });
});
