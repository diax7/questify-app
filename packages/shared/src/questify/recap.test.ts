import { describe, expect, it } from "vitest";
import { eventRecapSchema, recapRankSchema } from "#src/questify/recap";

const UUID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const souvenir = {
  id: "souvenir-lantern",
  kind: "frame",
  name: { ar: "فانوس", en: "Lantern" },
  visualKey: null,
};
const recap = {
  event: {
    id: UUID,
    name: { ar: "ملتقى", en: "Meetup" },
    date: "2030-01-01",
    city: { ar: "الرياض", en: "Riyadh" },
  },
  rank: { state: "final", value: 3 },
  questsDone: 7,
  souvenirs: [souvenir],
};
const accepts = (value: unknown) => eventRecapSchema.safeParse(value).success;

describe("eventRecapSchema", () => {
  it("keeps every field of a recap", () => {
    expect(eventRecapSchema.parse(recap)).toEqual(recap);
    const bare = {
      ...recap,
      event: { ...recap.event, city: null },
      rank: { state: "pending", value: null },
      questsDone: 0,
      souvenirs: [],
    };
    expect(eventRecapSchema.parse(bare)).toEqual(bare);
  });

  it("drops anything about the player or other players", () => {
    const extra = {
      ...recap,
      username: "sara_k",
      score: 90,
      balance: 40,
      players: 120,
      event: { ...recap.event, joinCode: "NAJD1" },
    };
    expect(eventRecapSchema.parse(extra)).toEqual(recap);
  });

  it("needs a UUID event id, both names and a YYYY-MM-DD date", () => {
    expect(accepts({ ...recap, event: { ...recap.event, id: "7" } })).toBe(false);
    expect(accepts({ ...recap, event: { ...recap.event, name: { ar: "ملتقى" } } })).toBe(false);
    for (const date of ["2030-1-1", "2030-01-01T10:00", ""])
      expect(accepts({ ...recap, event: { ...recap.event, date } })).toBe(false);
  });

  it("takes the quests done as a whole number from 0", () => {
    for (const questsDone of [-1, 1.5, "3", null])
      expect(accepts({ ...recap, questsDone })).toBe(false);
  });

  it("takes souvenirs as profile items only", () => {
    expect(accepts({ ...recap, souvenirs: [{ id: "x" }] })).toBe(false);
    expect(accepts({ ...recap, souvenirs: undefined })).toBe(false);
  });
});

describe("recapRankSchema", () => {
  it("pairs a final rank with its place, and pending or unranked with none", () => {
    expect(recapRankSchema.parse({ state: "final", value: 1 })).toEqual({
      state: "final",
      value: 1,
    });
    for (const state of ["pending", "unranked"])
      expect(recapRankSchema.parse({ state, value: null })).toEqual({ state, value: null });
  });

  it("refuses a final rank without a positive place, a place while pending, and the live state", () => {
    for (const value of [null, 0, -1, 1.5])
      expect(recapRankSchema.safeParse({ state: "final", value }).success).toBe(false);
    for (const state of ["pending", "unranked"])
      expect(recapRankSchema.safeParse({ state, value: 2 }).success).toBe(false);
    expect(recapRankSchema.safeParse({ state: "live", value: null }).success).toBe(false);
  });
});
