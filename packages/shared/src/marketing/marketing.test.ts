import { describe, expect, it } from "vitest";
import {
  MARKETING_CHANNELS,
  MARKETING_TEXT_VERSION,
  forYouEventSchema,
  marketingBodySchema,
  marketingSchema,
  optOutBodySchema,
  preferencesBodySchema,
} from "#src/marketing/marketing";

const state = { optedIn: false, changedAt: null };

describe("marketingBodySchema", () => {
  const ok = { textVersion: MARKETING_TEXT_VERSION, method: "settings", channels: { sms: true } };

  it("takes one or more channels, each a boolean", () => {
    expect(marketingBodySchema.safeParse(ok).success).toBe(true);
    expect(
      marketingBodySchema.safeParse({ ...ok, channels: { push: false, sms: false, email: true } })
        .success,
    ).toBe(true);
  });

  it.each([
    ["no channel", { ...ok, channels: {} }],
    ["an unknown channel", { ...ok, channels: { fax: true } }],
    ["a non-boolean", { ...ok, channels: { sms: 1 } }],
    ["the link's method", { ...ok, method: "opt_out_link" }],
    ["an odd version", { ...ok, textVersion: "v1" }],
    ["an extra field", { ...ok, playerId: "x" }],
  ])("refuses %s", (_name, body) => {
    expect(marketingBodySchema.safeParse(body).success).toBe(false);
  });

  it("names the three channels the database knows", () => {
    expect(MARKETING_CHANNELS).toEqual(["push", "sms", "email"]);
  });
});

describe("marketingSchema", () => {
  it("reads the caller's consent", () => {
    const body = {
      channels: { push: state, sms: state, email: state },
      asked: false,
      canOptIn: true,
    };
    expect(marketingSchema.parse(body)).toEqual(body);
  });
});

describe("preferencesBodySchema", () => {
  it("takes a city or none and up to eight distinct interests", () => {
    expect(preferencesBodySchema.safeParse({ cityId: null, interests: [] }).success).toBe(true);
    expect(
      preferencesBodySchema.safeParse({ cityId: "sa-riyadh", interests: ["sport", "music"] })
        .success,
    ).toBe(true);
  });

  it.each([
    ["a repeat", { cityId: null, interests: ["sport", "sport"] }],
    ["nine", { cityId: null, interests: Array.from({ length: 9 }, (_, i) => `i${i}`) }],
    ["no city key", { interests: [] }],
    ["a malformed id", { cityId: null, interests: ["Sport!"] }],
    ["an extra field", { cityId: null, interests: [], birthYear: 1990 }],
  ])("refuses %s", (_name, body) => {
    expect(preferencesBodySchema.safeParse(body).success).toBe(false);
  });
});

describe("optOutBodySchema", () => {
  it("takes a token-shaped text only", () => {
    expect(optOutBodySchema.safeParse({ token: "a".repeat(44) }).success).toBe(true);
    for (const token of ["", "short", "a b".repeat(10), "é".repeat(30), "a".repeat(81)]) {
      expect(optOutBodySchema.safeParse({ token }).success, token).toBe(false);
    }
  });
});

describe("forYouEventSchema", () => {
  it("reads an event card with its city and interests", () => {
    const card = {
      id: "5f3c2a10-9b1e-4d7a-8c55-0a1b2c3d4e5f",
      joinCode: "ABC234",
      name: { ar: null, en: "Meetup" },
      venue: { ar: null, en: null },
      kind: "physical",
      timezone: "Asia/Riyadh",
      startsAt: "2030-11-01T09:00:00+03:00",
      endsAt: "2030-11-01T17:00:00+03:00",
      statusNow: "scheduled",
      city: { ar: "الرياض", en: "Riyadh" },
      interests: ["sport"],
    };
    expect(forYouEventSchema.parse(card)).toEqual(card);
    expect(forYouEventSchema.safeParse({ ...card, statusNow: "ended" }).success).toBe(false);
  });
});
