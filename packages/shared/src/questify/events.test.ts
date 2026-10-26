import type { z } from "zod";
import { describe, expect, it } from "vitest";
import {
  RANK_STATES,
  citiesSchema,
  citySchema,
  ownEventSchema,
  ownEventsSchema,
  publicStampSchema,
} from "#src/questify/events";

const accepts = (schema: z.ZodType, value: unknown) => schema.safeParse(value).success;
const text = (length: number) => "a".repeat(length);
const UUID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const name = { ar: "ملتقى", en: "Meetup" };
const event = {
  eventId: UUID,
  name,
  date: "2030-01-01",
  startsAt: "2030-01-01T10:00:00.000Z",
  endsAt: "2030-01-01T12:00:00.000Z",
  timezone: "Asia/Riyadh",
  city: { ar: "الرياض", en: "Riyadh" },
  eventStatus: "ended",
  memberStatus: "active",
  score: 120,
  played: true,
  rank: 3,
  rankState: "final",
  isPublic: true,
};

describe("ownEventSchema", () => {
  it("keeps every field of a valid membership", () => {
    expect(ownEventSchema.parse(event)).toEqual(event);
  });

  it("keeps an event with no times, city or rank", () => {
    const bare = { ...event, startsAt: null, endsAt: null, city: null, rank: null };
    expect(ownEventSchema.parse(bare)).toEqual(bare);
  });

  it("needs the event id to be a UUID", () => {
    for (const eventId of ["7", "", UUID.toUpperCase().slice(1), undefined])
      expect(accepts(ownEventSchema, { ...event, eventId })).toBe(false);
  });

  it("needs both names as text", () => {
    for (const value of [{ ar: "ملتقى" }, { en: "Meetup" }, { ar: 1, en: "Meetup" }, undefined])
      expect(accepts(ownEventSchema, { ...event, name: value })).toBe(false);
  });

  it("takes the local date as exactly YYYY-MM-DD", () => {
    expect(accepts(ownEventSchema, { ...event, date: "2030-12-31" })).toBe(true);
    for (const date of [
      "2030-01-01T10:00",
      "2030-01-01 ",
      " 2030-01-01",
      "x2030-01-01",
      "2030-1-1",
      "20300101",
      "",
    ])
      expect(accepts(ownEventSchema, { ...event, date })).toBe(false);
  });

  it("names the five event statuses and refuses any other", () => {
    for (const eventStatus of ["draft", "scheduled", "live", "ended", "archived"])
      expect(ownEventSchema.parse({ ...event, eventStatus }).eventStatus).toBe(eventStatus);
    for (const eventStatus of ["", "cancelled", "Live", null, undefined])
      expect(accepts(ownEventSchema, { ...event, eventStatus })).toBe(false);
  });

  it("names the four member statuses and refuses any other", () => {
    for (const memberStatus of ["active", "left", "removed", "banned"])
      expect(ownEventSchema.parse({ ...event, memberStatus }).memberStatus).toBe(memberStatus);
    for (const memberStatus of ["", "invited", "Active", null, undefined])
      expect(accepts(ownEventSchema, { ...event, memberStatus })).toBe(false);
  });

  it("names the four rank states and refuses any other", () => {
    expect(RANK_STATES).toEqual(["live", "pending", "final", "unranked"]);
    for (const rankState of RANK_STATES)
      expect(ownEventSchema.parse({ ...event, rankState }).rankState).toBe(rankState);
    for (const rankState of ["", "ranked", null, undefined])
      expect(accepts(ownEventSchema, { ...event, rankState })).toBe(false);
  });

  it("takes the score as a whole number from 0", () => {
    for (const score of [0, 1, 1_000_000])
      expect(accepts(ownEventSchema, { ...event, score })).toBe(true);
    for (const score of [-1, 1.5, "12", null, undefined])
      expect(accepts(ownEventSchema, { ...event, score })).toBe(false);
  });

  it("takes the rank as a positive whole number or null", () => {
    for (const rank of [1, 50, null])
      expect(accepts(ownEventSchema, { ...event, rank })).toBe(true);
    for (const rank of [0, -1, 1.5, "3", undefined])
      expect(accepts(ownEventSchema, { ...event, rank })).toBe(false);
  });

  it("needs the flags as booleans", () => {
    for (const field of ["played", "isPublic"])
      for (const value of ["true", 1, null, undefined])
        expect(accepts(ownEventSchema, { ...event, [field]: value })).toBe(false);
  });

  it("needs the timezone as text and the times as text or null", () => {
    expect(accepts(ownEventSchema, { ...event, timezone: undefined })).toBe(false);
    expect(accepts(ownEventSchema, { ...event, startsAt: undefined })).toBe(false);
    expect(accepts(ownEventSchema, { ...event, endsAt: 5 })).toBe(false);
  });
});

describe("ownEventsSchema", () => {
  it("keeps the page and its cursor", () => {
    const page = { events: [event], nextCursor: "abc" };
    expect(ownEventsSchema.parse(page)).toEqual(page);
    const last = { events: [], nextCursor: null };
    expect(ownEventsSchema.parse(last)).toEqual(last);
  });

  it("refuses a page without events or without a cursor field", () => {
    for (const value of [{ nextCursor: null }, { events: [] }, { events: [{}], nextCursor: null }])
      expect(accepts(ownEventsSchema, value)).toBe(false);
  });
});

describe("publicStampSchema", () => {
  const stamp = { name, date: "2030-01-01", city: null, rank: 2 };

  it("keeps the four fields of a stamp and drops anything about the player's score or event", () => {
    expect(publicStampSchema.parse(stamp)).toEqual(stamp);
    expect(
      publicStampSchema.parse({ ...stamp, eventId: UUID, score: 90, memberStatus: "active" }),
    ).toEqual(stamp);
  });

  it("takes the date as exactly YYYY-MM-DD and the rank as positive or null", () => {
    expect(accepts(publicStampSchema, { ...stamp, rank: null })).toBe(true);
    for (const date of ["2030-01-01T00:00", "x2030-01-01", "2030-1-1"])
      expect(accepts(publicStampSchema, { ...stamp, date })).toBe(false);
    for (const rank of [0, -3, 1.5])
      expect(accepts(publicStampSchema, { ...stamp, rank })).toBe(false);
  });
});

describe("citySchema and citiesSchema", () => {
  const city = { id: "riyadh", name: { ar: "الرياض", en: "Riyadh" } };

  it("keeps the id and both names", () => {
    expect(citySchema.parse(city)).toEqual(city);
    expect(citiesSchema.parse({ cities: [city] })).toEqual({ cities: [city] });
    expect(citiesSchema.parse({ cities: [] })).toEqual({ cities: [] });
  });

  it("bounds the id to 1..40 characters", () => {
    for (const id of [text(1), text(40)]) expect(accepts(citySchema, { ...city, id })).toBe(true);
    for (const id of ["", text(41), 7, undefined])
      expect(accepts(citySchema, { ...city, id })).toBe(false);
  });

  it("needs both names", () => {
    for (const value of [{ ar: "الرياض" }, { en: "Riyadh" }, undefined])
      expect(accepts(citySchema, { ...city, name: value })).toBe(false);
  });

  it("refuses a list that is missing or holds a malformed city", () => {
    for (const value of [{}, { cities: [{ id: "riyadh" }] }, { cities: null }])
      expect(accepts(citiesSchema, value)).toBe(false);
  });
});
