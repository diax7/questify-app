import { describe, expect, it } from "vitest";
import {
  BLANK_DRAFT,
  createBodyOf,
  draftOf,
  editBodyOf,
  hasUnsavedEdits,
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
  cityId: null,
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
  meetSomeone: true,
  miniGames: true,
  community: true,
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
      cityId: null,
      interests: [],
    });
  });

  it("shows saved interests, and none when an older API sends none", () => {
    expect(draftOf({ ...EVENT, interests: ["sport", "music"] }).interests).toEqual([
      "sport",
      "music",
    ]);
    expect(draftOf(EVENT).interests).toEqual([]);
  });

  it("shows a saved city by its id", () => {
    expect(draftOf({ ...EVENT, cityId: "sa-riyadh" }).cityId).toBe("sa-riyadh");
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
      cityId: null,
      interests: [],
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

describe("createBodyOf with a city", () => {
  it("sends the chosen city", () => {
    expect(createBodyOf({ ...BLANK_DRAFT, cityId: "sa-jeddah" })["cityId"]).toBe("sa-jeddah");
  });

  it("sends no city for an online event, whatever was picked before", () => {
    expect(createBodyOf({ ...BLANK_DRAFT, kind: "virtual", cityId: "sa-jeddah" })["cityId"]).toBe(
      null,
    );
  });
});

describe("interests in the bodies", () => {
  it("sends the chosen interests on create and only a change on edit", () => {
    const tagged = { ...BLANK_DRAFT, interests: ["sport", "art"] };
    expect(createBodyOf(tagged)["interests"]).toEqual(["sport", "art"]);
    expect(editBodyOf({ ...tagged, interests: ["sport"] }, tagged)).toEqual({
      interests: ["sport"],
    });
    expect(editBodyOf(tagged, tagged)).toEqual({});
    expect(editBodyOf({ ...tagged, interests: [] }, tagged)).toEqual({ interests: [] });
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

  it("sends the city only when it changes, and null when it is cleared", () => {
    expect(editBodyOf({ ...before, cityId: "sa-abha" }, before)).toEqual({ cityId: "sa-abha" });
    const placed = { ...before, cityId: "sa-abha" };
    expect(editBodyOf(placed, placed)).toEqual({});
    expect(editBodyOf({ ...placed, cityId: null }, placed)).toEqual({ cityId: null });
  });

  it("clears the city when the event becomes online", () => {
    const placed = { ...before, cityId: "sa-abha" };
    expect(editBodyOf({ ...placed, kind: "virtual" }, placed)).toEqual({
      kind: "virtual",
      cityId: null,
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

describe("hasUnsavedEdits", () => {
  const saved = draftOf(EVENT);

  it("is false for the form as the saved event fills it", () => {
    expect(hasUnsavedEdits(saved, EVENT)).toBe(false);
  });

  it.each([
    ["a name", { nameEn: "Najd Meetup" }],
    ["the access", { access: "private" as const }],
    ["the end time", { endsAt: "2030-11-02T17:00" }],
    ["the zone", { timezone: "Asia/Dubai" }],
  ])("is true once %s is typed", (_name, change) => {
    expect(hasUnsavedEdits({ ...saved, ...change }, EVENT)).toBe(true);
  });

  it("is false again once the edit is typed back", () => {
    const typed = { ...saved, nameEn: "Najd Meetup" };
    expect(hasUnsavedEdits({ ...typed, nameEn: "" }, EVENT)).toBe(false);
  });
});
