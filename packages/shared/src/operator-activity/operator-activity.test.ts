import { describe, expect, it } from "vitest";
import {
  STAFF_BRIEFING_BODY_MAX,
  STAFF_BRIEFING_TITLE_MAX,
  blankStaffBriefing,
  checkStaffBriefing,
  operatorActivitySchema,
  staffBriefingBodySchema,
  staffBriefingTextIssue,
} from "#src/operator-activity/operator-activity";

const GOOD = {
  titleAr: "تغيير البوابة",
  titleEn: "Gate change",
  bodyAr: "البوابة ٣ مغلقة. استخدموا البوابة 1.",
  bodyEn: "Gate 3 is closed. Use gate 1.",
};

describe("checking a staff briefing", () => {
  it("cleans every field as an announcement is: invisible characters out, spaces one, digits Western", () => {
    const checked = checkStaffBriefing({
      ...GOOD,
      titleEn: "  Gate\n\tchange\u200B  ",
      bodyAr: "البوابة ٣\u00A0مغلقة",
    });
    expect(checked).toEqual({
      ok: true,
      draft: { ...GOOD, bodyAr: "البوابة 3 مغلقة" },
    });
  });

  it("names the first field that fails, in the order title Arabic, title English, text Arabic, text English", () => {
    expect(checkStaffBriefing({ ...GOOD, titleEn: "", bodyAr: "" })).toEqual({
      ok: false,
      field: "titleEn",
      issue: "required",
    });
    expect(checkStaffBriefing({ ...GOOD, titleAr: " \u200B ", bodyEn: "" })).toMatchObject({
      field: "titleAr",
    });
    expect(checkStaffBriefing(blankStaffBriefing())).toMatchObject({
      ok: false,
      field: "titleAr",
      issue: "required",
    });
  });

  it("keeps the text to 140 code points and the title to 60, counting an emoji once", () => {
    const edge = "ا".repeat(STAFF_BRIEFING_BODY_MAX);
    expect(checkStaffBriefing({ ...GOOD, bodyAr: edge }).ok).toBe(true);
    expect(checkStaffBriefing({ ...GOOD, bodyAr: `${edge}ا` })).toEqual({
      ok: false,
      field: "bodyAr",
      issue: "too_long",
    });
    expect(checkStaffBriefing({ ...GOOD, titleEn: "x".repeat(STAFF_BRIEFING_TITLE_MAX) }).ok).toBe(
      true,
    );
    expect(checkStaffBriefing({ ...GOOD, titleEn: "x".repeat(61) })).toMatchObject({
      field: "titleEn",
      issue: "too_long",
    });
    const emoji = "😀".repeat(STAFF_BRIEFING_BODY_MAX);
    expect(checkStaffBriefing({ ...GOOD, bodyEn: emoji }).ok).toBe(true);
  });

  it("refuses an address and a phone number in any field", () => {
    expect(checkStaffBriefing({ ...GOOD, bodyEn: "See example.com" })).toMatchObject({
      field: "bodyEn",
      issue: "looks_like_address",
    });
    expect(checkStaffBriefing({ ...GOOD, bodyAr: "اتصل 0551234567" })).toMatchObject({
      field: "bodyAr",
      issue: "looks_like_phone",
    });
    expect(staffBriefingTextIssue("Call 055 123 4567", "bodyEn")).toBe("looks_like_phone");
    expect(staffBriefingTextIssue("Gate 3", "titleEn")).toBeNull();
  });
});

describe("the briefing body", () => {
  it("takes exactly the four fields", () => {
    expect(staffBriefingBodySchema.safeParse(GOOD).success).toBe(true);
    expect(staffBriefingBodySchema.safeParse({ ...GOOD, sendAt: null }).success).toBe(false);
    expect(staffBriefingBodySchema.safeParse({ titleEn: "x" }).success).toBe(false);
    expect(staffBriefingBodySchema.safeParse({ ...GOOD, bodyEn: "x".repeat(1001) }).success).toBe(
      false,
    );
  });
});

describe("the activity answer", () => {
  const id = "7d1c9d3e-5b0a-4c9e-8d31-5a3f6c2b9e11";
  const row = {
    id,
    username: "nora",
    scansHour: 3,
    scans: 20,
    awards: 1,
    handOvers: 2,
    handled: 0,
    lastAt: "2026-11-02T10:00:00+00:00",
    lastAction: "scan",
    stations: [
      {
        questId: id,
        titleAr: null,
        titleEn: "Gate",
        scans: 20,
        lastAt: "2026-11-02T10:00:00+00:00",
      },
    ],
  };
  const answer = {
    asOf: "2026-11-02T10:05:00+00:00",
    reachable: 1,
    operators: [row],
    recent: [],
    briefings: [],
  };

  it("reads what the door sends", () => {
    expect(operatorActivitySchema.safeParse(answer).success).toBe(true);
    expect(
      operatorActivitySchema.safeParse({
        ...answer,
        operators: [{ ...row, lastAt: null, lastAction: null, stations: [] }],
      }).success,
    ).toBe(true);
  });

  it("refuses anything beyond usernames and counts: an extra field, a bad action, a negative count", () => {
    for (const operators of [
      [{ ...row, playerId: id }],
      [{ ...row, lastAction: "delete" }],
      [{ ...row, scans: -1 }],
      [{ ...row, stations: Array.from({ length: 6 }, () => row.stations[0]) }],
    ]) {
      expect(operatorActivitySchema.safeParse({ ...answer, operators }).success).toBe(false);
    }
    expect(operatorActivitySchema.safeParse({ ...answer, extra: 1 }).success).toBe(false);
  });

  it("needs the number of operators a briefing reaches, a whole number from 0", () => {
    const { reachable: _removed, ...without } = answer;
    expect(operatorActivitySchema.safeParse(without).success).toBe(false);
    expect(operatorActivitySchema.safeParse({ ...answer, reachable: -1 }).success).toBe(false);
    expect(operatorActivitySchema.safeParse({ ...answer, reachable: 1.5 }).success).toBe(false);
    expect(operatorActivitySchema.safeParse({ ...answer, reachable: 0 }).success).toBe(true);
  });
});
