import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { DEFAULT_TERMS } from "@questify/shared";
import { createEvents, merge, type Actor } from "#src/events/events";
import type { EventRecord } from "#src/events/store";

const TIMES = { startsAt: "2030-11-01T09:00", endsAt: "2030-11-01T17:00" };

const STORED: EventRecord = {
  id: "11111111-1111-4111-8111-111111111111",
  joinCode: "ABC234",
  name: { ar: "ملتقى", en: "Meetup" },
  kind: "virtual",
  venue: { ar: "الرياض", en: "Riyadh" },
  access: "unlisted",
  joinMethods: ["link"],
  timezone: "Asia/Dubai",
  dayStartHour: 6,
  startsAt: new Date("2030-11-01T05:00:00Z"),
  endsAt: new Date("2030-11-01T13:00:00Z"),
  status: "draft",
  statusNow: "draft",
  createdAt: new Date("2030-01-01T00:00:00Z"),
  rankingOn: true,
  rankingTodayOn: true,
  shareQuestsOn: true,
  meetSomeoneOn: true,
  miniGamesOn: true,
  communityOn: true,
  flashQuestsOn: true,
  boostsOn: true,
  helpDeskOn: true,
  questRatingsOn: false,
  terms: DEFAULT_TERMS,
  venuePin: { lat: 24.7136, lng: 46.6753 },
  venueRadiusM: 800,
  cityId: null,
  interests: [],
};

describe("merge", () => {
  it("fills a new event's fields from the defaults", () => {
    expect(merge(undefined, { name: { en: "Meetup" }, ...TIMES })).toEqual({
      nameAr: null,
      nameEn: "Meetup",
      kind: "physical",
      venueAr: null,
      venueEn: null,
      access: "public",
      joinMethods: ["code", "qr", "link"],
      timezone: "Asia/Riyadh",
      dayStartHour: 4,
      startsAt: new Date("2030-11-01T06:00:00Z"),
      endsAt: new Date("2030-11-01T14:00:00Z"),
      venuePin: null,
      venueRadiusM: 1000,
      cityId: null,
      interests: [],
    });
  });

  it("keeps every stored field the input leaves out", () => {
    expect(merge(STORED, {})).toEqual({
      nameAr: "ملتقى",
      nameEn: "Meetup",
      kind: "virtual",
      venueAr: "الرياض",
      venueEn: "Riyadh",
      access: "unlisted",
      joinMethods: ["link"],
      timezone: "Asia/Dubai",
      dayStartHour: 6,
      startsAt: STORED.startsAt,
      endsAt: STORED.endsAt,
      venuePin: STORED.venuePin,
      venueRadiusM: 800,
      cityId: null,
      interests: [],
    });
  });

  it("sets, moves and clears the venue pin and its radius (T-303b)", () => {
    expect(merge(STORED, { venuePin: { lat: 21.5, lng: 39.2 }, venueRadiusM: 300 })).toMatchObject({
      venuePin: { lat: 21.5, lng: 39.2 },
      venueRadiusM: 300,
    });
    expect(merge(STORED, { venuePin: null })).toMatchObject({ venuePin: null, venueRadiusM: 800 });
  });

  it("takes every field the input sends, blanks as none, a name in one language enough", () => {
    expect(
      merge(STORED, {
        name: { ar: " ملتقى نجد ", en: "  " },
        kind: "workplace",
        venue: { ar: "" },
        access: "public",
        joinMethods: ["code", "code", "public_list"],
        dayStartHour: 0,
      }),
    ).toMatchObject({
      nameAr: "ملتقى نجد",
      nameEn: null,
      kind: "workplace",
      venueAr: null,
      venueEn: null,
      access: "public",
      joinMethods: ["code", "public_list"],
      dayStartHour: 0,
    });
  });

  it("sets, keeps and clears the city; a virtual event has none (T-403)", () => {
    const physical = { ...STORED, kind: "physical" as const, cityId: "sa-riyadh" };
    expect(merge(physical, {})).toMatchObject({ cityId: "sa-riyadh" });
    expect(merge(physical, { cityId: "sa-jeddah" })).toMatchObject({ cityId: "sa-jeddah" });
    expect(merge(physical, { cityId: null })).toMatchObject({ cityId: null });
    expect(merge(physical, { kind: "virtual", cityId: null })).toMatchObject({
      kind: "virtual",
      cityId: null,
    });
    expect(merge(STORED, { kind: "workplace", cityId: "sa-abha" })).toMatchObject({
      cityId: "sa-abha",
    });
  });

  it("sets, keeps and clears the interests (T-407)", () => {
    const tagged = { ...STORED, interests: ["sport", "music"] };
    expect(merge(tagged, {})).toMatchObject({ interests: ["sport", "music"] });
    expect(merge(tagged, { interests: ["art"] })).toMatchObject({ interests: ["art"] });
    expect(merge(tagged, { interests: [] })).toMatchObject({ interests: [] });
    expect(merge(STORED, { interests: ["art", "food", "tech"] })).toMatchObject({
      interests: ["art", "food", "tech"],
    });
  });

  it("keeps the instants when only the zone changes, and reads new times in the new zone", () => {
    expect(merge(STORED, { timezone: "Asia/Riyadh" })).toMatchObject({
      startsAt: STORED.startsAt,
      timezone: "Asia/Riyadh",
    });
    expect(merge(STORED, { timezone: "Asia/Riyadh", startsAt: "2030-11-01T09:00" })).toMatchObject({
      startsAt: new Date("2030-11-01T06:00:00Z"),
      endsAt: STORED.endsAt,
    });
  });

  it.each([
    ["name", undefined, { name: { ar: "", en: " " }, ...TIMES }],
    ["name", STORED, { name: {} }],
    ["timezone", STORED, { timezone: "asia/dubai" }],
    ["startsAt", undefined, { name: { en: "A" }, endsAt: TIMES.endsAt }],
    ["startsAt", STORED, { startsAt: "tomorrow" }],
    ["startsAt", { ...STORED, startsAt: null }, {}],
    ["endsAt", undefined, { name: { en: "A" }, startsAt: TIMES.startsAt }],
    ["endsAt", { ...STORED, endsAt: null }, {}],
    ["endsAt", STORED, { endsAt: "2030-11-01T09:00" }],
    ["endsAt", STORED, { endsAt: "2030-11-01T08:59" }],
    ["joinMethods", STORED, { joinMethods: [] }],
    ["joinMethods", STORED, { joinMethods: ["public_list"] }],
    ["cityId", STORED, { cityId: "sa-riyadh" }],
    ["interests", STORED, { interests: ["sport", "music", "tech", "food"] }],
    ["interests", STORED, { interests: ["sport", "sport"] }],
    ["cityId", { ...STORED, kind: "physical", cityId: "sa-riyadh" }, { kind: "virtual" }],
    [
      "joinMethods",
      { ...STORED, access: "public", joinMethods: ["public_list"] },
      { access: "private" },
    ],
  ] as const)("refuses, naming %s", (field, current, input) => {
    expect(merge(current, input)).toEqual({ kind: "invalid", field });
  });

  it("accepts an end one minute after the start", () => {
    expect(merge(STORED, { endsAt: "2030-11-01T09:01" })).toMatchObject({
      endsAt: new Date("2030-11-01T05:01:00Z"),
    });
  });
});

/** A pool whose transactions fail at the first statement after the context, with the given database error. */
function failingPool(code: string): Pool {
  const client = {
    query: async (sql: string) => {
      if (sql === "BEGIN" || sql === "ROLLBACK" || sql.startsWith("SELECT set_config")) {
        return { rows: [] };
      }
      throw Object.assign(new Error("database error"), { code });
    },
    release: () => undefined,
  };
  return { connect: async () => client } as unknown as Pool;
}

const ACTOR: Actor = {
  organizerId: "22222222-2222-4222-8222-222222222222",
  staffUserId: "33333333-3333-4333-8333-333333333333",
  organizer: { id: "22222222-2222-4222-8222-222222222222", role: "owner", eventScope: null },
};
const CALLER = {
  address: "127.0.0.1",
  userAgent: null,
  log: () => undefined,
  requestId: undefined,
};

describe("database errors the flows answer", () => {
  it("answers an interest the catalog refuses as an invalid interests field, on create and edit", async () => {
    const events = createEvents({ pool: failingPool("EI422") });
    await expect(
      events.create(ACTOR, { name: { en: "A" }, ...TIMES, interests: ["bogus"] }, CALLER),
    ).resolves.toEqual({ kind: "invalid", field: "interests" });
    await expect(events.update(ACTOR, STORED.id, {}, CALLER)).resolves.toEqual({
      kind: "invalid",
      field: "interests",
    });
  });
});

describe("database errors the flows do not expect", () => {
  it.each(["23514", "40001", "QE403"])("pass %s through an edit", async (code) => {
    const events = createEvents({ pool: failingPool(code) });
    await expect(events.update(ACTOR, STORED.id, {}, CALLER)).rejects.toMatchObject({ code });
  });

  it.each(["23514", "40001", "QE422"])("pass %s through ending early", async (code) => {
    const events = createEvents({ pool: failingPool(code) });
    await expect(events.endEarly(ACTOR, STORED.id, CALLER)).rejects.toMatchObject({ code });
  });
});
