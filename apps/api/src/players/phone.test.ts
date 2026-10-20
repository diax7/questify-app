import { randomInt } from "node:crypto";
import { describe, expect, it } from "vitest";
import { normalizeSaudiMobile } from "#src/players/phone";

const STORED = /^\+9665[0-9]{8}$/;

describe("normalizeSaudiMobile", () => {
  it.each([
    "0551234567",
    "551234567",
    "+966551234567",
    "966551234567",
    "00966551234567",
    "+966 0551234567",
    "+966 55 123 4567",
    "055-123-4567",
    "(055) 123.4567",
    "٠٥٥١٢٣٤٥٦٧",
    "۰۵۵۱۲۳۴۵۶۷",
    "‪+966 55 123 4567‬",
    "‎055 123 4567",
  ])("reads %j as +966551234567", (typed) => {
    expect(normalizeSaudiMobile(typed)).toBe("+966551234567");
  });

  it.each([
    "",
    "0451234567",
    "05512345678",
    "055123456",
    "+971501234567",
    "+1 415 555 0100",
    "9665512345",
    "+966 5512 345 678 9",
    "phone",
    "+96655123456a",
    // A country code only counts at the start.
    "5+96612345678",
    "50096612345678",
    "5966551234567",
  ])("refuses %j", (typed) => {
    expect(normalizeSaudiMobile(typed)).toBeUndefined();
  });

  it("is idempotent and always matches what the database stores, over 2,000 random numbers", () => {
    for (let n = 0; n < 2000; n += 1) {
      const national = `5${String(randomInt(0, 100_000_000)).padStart(8, "0")}`;
      for (const typed of [`0${national}`, `+966${national}`, `00966 ${national}`]) {
        const stored = normalizeSaudiMobile(typed);
        expect(stored).toMatch(STORED);
        expect(normalizeSaudiMobile(stored ?? "")).toBe(stored);
      }
    }
  });
});
