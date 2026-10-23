import { describe, expect, it } from "vitest";
import {
  BLANK_DRAFT,
  createBodyOf,
  draftOf,
  editBodyOf,
  nameFor,
  venueIsValid,
  type EventView,
} from "#src/lib/events.ts";

const EVENT: EventView = {
  id: "e1",
  joinCode: "ABC234",
  name: { ar: "ملتقى نجد", en: null },
  kind: "physical",
  venue: { ar: null, en: "Riyadh Front" },
  venuePin: null,
  venueRadiusM: 1000,
  access: "public",
  joinMethods: ["code", "qr"],
  timezone: "Asia/Riyadh",
  dayStartHour: 4,
  startsAt: "2030-11-01T06:00:00.000Z",
  endsAt: "2030-11-01T14:00:00.000Z",
  status: "draft",
  statusNow: "draft",
  ranking: true,
  rankingToday: true,
  shareQuests: true,
};

describe("nameFor", () => {
  it("uses the page's language and falls back to the other", () => {
    expect(nameFor(EVENT, "ar")).toBe("ملتقى نجد");
    expect(nameFor(EVENT, "en")).toBe("ملتقى نجد");
    expect(nameFor({ name: { ar: "أ", en: "B" } }, "en")).toBe("B");
    expect(nameFor({ name: { ar: null, en: null } }, "en")).toBe("");
  });
});

describe("draftOf", () => {
  it("shows the times as the wall clock in the event's zone, and blanks for missing text", () => {
    expect(draftOf(EVENT)).toMatchObject({
      nameEn: "",
      venueAr: "",
      venueEn: "Riyadh Front",
      startsAt: "2030-11-01T09:00",
      endsAt: "2030-11-01T17:00",
      venueLat: "",
      venueLng: "",
      venueRadius: "1000",
    });
  });

  it("shows a saved pin as typed numbers and the radius as text", () => {
    expect(
      draftOf({ ...EVENT, venuePin: { lat: 24.7136, lng: 46.6753 }, venueRadiusM: 800 }),
    ).toMatchObject({
      venueLat: "24.7136",
      venueLng: "46.6753",
      venueRadius: "800",
    });
  });
});

describe("createBodyOf", () => {
  it("sends every field with the times and their zone", () => {
    expect(
      createBodyOf({
        ...BLANK_DRAFT,
        nameEn: "Meetup",
        startsAt: "2030-01-01T09:00",
        endsAt: "2030-01-01T10:00",
      }),
    ).toEqual({
      name: { ar: "", en: "Meetup" },
      kind: "physical",
      venue: { ar: "", en: "" },
      venuePin: null,
      venueRadiusM: 1000,
      access: "public",
      joinMethods: ["code", "qr", "link"],
      dayStartHour: 4,
      timezone: "Asia/Riyadh",
      startsAt: "2030-01-01T09:00",
      endsAt: "2030-01-01T10:00",
    });
  });
});

describe("createBodyOf with a venue pin", () => {
  it("sends the typed pin as numbers and the radius as a number", () => {
    const body = createBodyOf({
      ...BLANK_DRAFT,
      venueLat: "24.7136",
      venueLng: "46.6753",
      venueRadius: "800",
    });
    expect(body["venuePin"]).toEqual({ lat: 24.7136, lng: 46.6753 });
    expect(body["venueRadiusM"]).toBe(800);
  });
});

describe("venueIsValid", () => {
  it("accepts no pin, or a whole pin in range, with a radius from 100 to 20000", () => {
    expect(venueIsValid(BLANK_DRAFT)).toBe(true);
    expect(venueIsValid({ ...BLANK_DRAFT, venueLat: "24.7", venueLng: "46.6" })).toBe(true);
    expect(venueIsValid({ ...BLANK_DRAFT, venueRadius: "100" })).toBe(true);
    expect(venueIsValid({ ...BLANK_DRAFT, venueRadius: "20000" })).toBe(true);
  });

  it("refuses half a pin, a pin out of range and a radius out of bounds", () => {
    expect(venueIsValid({ ...BLANK_DRAFT, venueLat: "24.7" })).toBe(false);
    expect(venueIsValid({ ...BLANK_DRAFT, venueLng: "46.6" })).toBe(false);
    expect(venueIsValid({ ...BLANK_DRAFT, venueLat: "91", venueLng: "46.6" })).toBe(false);
    expect(venueIsValid({ ...BLANK_DRAFT, venueRadius: "99" })).toBe(false);
    expect(venueIsValid({ ...BLANK_DRAFT, venueRadius: "20001" })).toBe(false);
    expect(venueIsValid({ ...BLANK_DRAFT, venueRadius: "" })).toBe(false);
    expect(venueIsValid({ ...BLANK_DRAFT, venueRadius: "500.5" })).toBe(false);
  });
});

describe("editBodyOf", () => {
  const before = draftOf(EVENT);

  it("sends nothing when nothing changed", () => {
    expect(editBodyOf(before, before)).toEqual({});
  });

  it("sends only the changed fields", () => {
    expect(editBodyOf({ ...before, nameEn: "Najd Meetup", access: "unlisted" }, before)).toEqual({
      name: { ar: "ملتقى نجد", en: "Najd Meetup" },
      access: "unlisted",
    });
  });

  it("sends the pin and radius only when they change, and null when the pin is cleared", () => {
    expect(editBodyOf({ ...before, venueLat: "24.7", venueLng: "46.6" }, before)).toEqual({
      venuePin: { lat: 24.7, lng: 46.6 },
    });
    expect(editBodyOf({ ...before, venueRadius: "500" }, before)).toEqual({ venueRadiusM: 500 });
    const pinned = { ...before, venueLat: "24.7", venueLng: "46.6" };
    expect(editBodyOf({ ...pinned, venueLat: "", venueLng: "" }, pinned)).toEqual({
      venuePin: null,
    });
  });

  it("sends a later end alone, so a live event's start is never touched", () => {
    expect(editBodyOf({ ...before, endsAt: "2030-11-02T17:00" }, before)).toEqual({
      endsAt: "2030-11-02T17:00",
    });
  });

  it.each([
    ["the zone", { timezone: "Asia/Dubai" }],
    ["the start", { startsAt: "2030-11-01T08:00" }],
  ])("sends the zone and both times when %s changes", (_name, change) => {
    const after = { ...before, ...change };
    expect(editBodyOf(after, before)).toEqual({
      timezone: after.timezone,
      startsAt: after.startsAt,
      endsAt: after.endsAt,
    });
  });
});
