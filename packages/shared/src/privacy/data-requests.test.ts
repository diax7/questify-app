import { describe, expect, it } from "vitest";
import {
  dataExportFileName,
  isCaseReference,
  isDataRequestReason,
} from "#src/privacy/data-requests";

describe("data requests (shared rules)", () => {
  it("accepts the two reason codes only", () => {
    expect(isDataRequestReason("legal_request")).toBe(true);
    expect(isDataRequestReason("player_request")).toBe(true);
    expect(isDataRequestReason("curious")).toBe(false);
    expect(isDataRequestReason(undefined)).toBe(false);
  });

  it("accepts an opaque case reference", () => {
    for (const good of [
      "LEGAL-2026/14",
      "CR-2026.7",
      "abc",
      "A1234567",
      "x".repeat(64),
      "case_1",
    ]) {
      expect(isCaseReference(good), good).toBe(true);
    }
  });

  it("refuses anything that could carry a name, a contact or an id number", () => {
    const bad = [
      "966551234567",
      "1234567890",
      "ID1234567890",
      "+966551234567",
      "a@b.sa",
      "CASE 1",
      "ab",
      "x".repeat(65),
      "12345",
      "محمد",
      "",
      42,
    ];
    for (const value of bad) {
      expect(isCaseReference(value), String(value)).toBe(false);
    }
  });

  it("names the file by the UTC date in Western digits", () => {
    expect(dataExportFileName(new Date("2026-11-03T23:30:00Z"))).toBe(
      "questify-data-2026-11-03.json",
    );
  });
});
