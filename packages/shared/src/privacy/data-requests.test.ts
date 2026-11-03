import { describe, expect, it } from "vitest";
import {
  dataEraseAnswerSchema,
  dataExportFileName,
  isCaseReference,
  isDataRequestReason,
  legalRequestSchema,
  pendingAnswerSchema,
} from "#src/privacy/data-requests";

const EVENT_ID = "8f0f8b8a-1d1b-4c55-9a77-0f6a6c9c1a11";
const REDEMPTION_ID = "3c1e2f44-5b6a-4d7e-8f90-a1b2c3d4e5f6";

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
      "LEGAL-2026/14-A/7",
      "AB12-CD34-EF56-GH78",
      "A1-2-3-4-5-6-7",
    ]) {
      expect(isCaseReference(good), good).toBe(true);
    }
  });

  it("refuses anything that could carry a name, a contact or an id number", () => {
    const bad = [
      "966551234567",
      "1234567890",
      "ID1234567890",
      "ID-1234-567-890",
      "p055-123-4567",
      "p055.123_4567",
      "CASE/9665/5123/4567",
      "1-2-3-4-5-6-7-8-A",
      "+966551234567",
      "a@b.sa",
      "CASE 1",
      "ab",
      "x".repeat(65),
      "12345",
      "محمد",
      "",
      42,
      ["CASE-1"],
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

  it("reads a legal request record with every action and source", () => {
    for (const action of ["player.data_export", "player.delete"]) {
      for (const source of ["player", "admin", "reapply"]) {
        const row = {
          at: "2026-11-03T10:00:00Z",
          action,
          source,
          reasonCode: null,
          reference: null,
          by: null,
        };
        expect(legalRequestSchema.parse(row)).toEqual(row);
      }
    }
    const good = {
      at: "2026-11-03T10:00:00Z",
      action: "player.delete",
      source: "admin",
      reasonCode: "legal_request",
      reference: "CR-1",
      by: "Admin",
    };
    expect(legalRequestSchema.safeParse({ ...good, at: "" }).success).toBe(false);
    expect(legalRequestSchema.safeParse({ ...good, action: "player.export" }).success).toBe(false);
    expect(legalRequestSchema.safeParse({ ...good, source: "console" }).success).toBe(false);
    expect(legalRequestSchema.safeParse({ ...good, extra: 1 }).success).toBe(false);
  });

  it("reads the admin erase answer", () => {
    for (const outcome of ["erased", "already_deleted"]) {
      const answer = { outcome, events: [EVENT_ID] };
      expect(dataEraseAnswerSchema.parse(answer)).toEqual(answer);
    }
    expect(dataEraseAnswerSchema.safeParse({ outcome: "gone", events: [] }).success).toBe(false);
    expect(
      dataEraseAnswerSchema.safeParse({ outcome: "erased", events: [], extra: 1 }).success,
    ).toBe(false);
  });

  it("reads the pending handovers answer", () => {
    const item = {
      redemptionId: REDEMPTION_ID,
      eventId: EVENT_ID,
      event: { ar: "حدث", en: null },
      item: { ar: null, en: "Mug" },
      rankPrize: false,
    };
    expect(pendingAnswerSchema.parse({ pending: [item] })).toEqual({ pending: [item] });
    expect(pendingAnswerSchema.safeParse({ pending: [{ ...item, extra: 1 }] }).success).toBe(false);
    expect(
      pendingAnswerSchema.safeParse({ pending: [{ ...item, event: { ar: null, en: null, x: 1 } }] })
        .success,
    ).toBe(false);
    expect(
      pendingAnswerSchema.safeParse({ pending: [{ ...item, item: { ar: null, en: null, x: 1 } }] })
        .success,
    ).toBe(false);
    expect(pendingAnswerSchema.safeParse({ pending: [], extra: 1 }).success).toBe(false);
  });
});
