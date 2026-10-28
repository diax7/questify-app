import { describe, expect, it } from "vitest";
import {
  announcementIssueKey,
  announcementPayload,
  blankAnnouncement,
} from "#src/lib/announcements.ts";
const GOOD = { titleAr: "الغداء", titleEn: "Lunch", bodyAr: "القاعة ٢", bodyEn: "Hall 2" };
describe("the dashboard announcement draft", () => {
  it("starts empty and cannot send an invalid draft", () => {
    expect(announcementPayload(blankAnnouncement(), false, "", "Asia/Riyadh")).toBeNull();
    expect(
      announcementPayload({ ...GOOD, bodyAr: "example.com" }, false, "", "Asia/Riyadh"),
    ).toBeNull();
  });
  it("cleans and converts the event's wall time, not the browser's zone", () => {
    expect(announcementPayload(GOOD, true, "2026-11-01T15:00", "Asia/Riyadh")).toEqual({
      ...GOOD,
      bodyAr: "القاعة 2",
      sendAt: "2026-11-01T12:00:00.000Z",
    });
    expect(announcementPayload(GOOD, false, "", "Asia/Riyadh")?.sendAt).toBeNull();
  });
  it("refuses empty, impossible local times and unknown zones without throwing", () => {
    for (const local of ["", "2026-02-30T12:00", "oops"])
      expect(announcementPayload(GOOD, true, local, "Asia/Riyadh")).toBeNull();
    expect(announcementPayload(GOOD, true, "2026-11-01T15:00", "Not/AZone")).toBeNull();
  });
  it("has specific bilingual messages for every filter and time issue", () => {
    for (const issue of [
      "required",
      "too_long",
      "looks_like_address",
      "looks_like_phone",
      "control_characters",
      "sendAt:past",
      "sendAt:too_far",
      "sendAt:before_start",
      "sendAt:after_end",
    ]) {
      expect(announcementIssueKey(issue)).toMatch(/^announcements.page.issue./);
    }
  });
});
