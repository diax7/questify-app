import { describe, expect, it } from "vitest";
import { MESSAGES } from "#src/i18n/messages";
import {
  MAP_AMENITIES,
  MAP_QUEST_STATES,
  amenityKey,
  mapBodySchema,
  mapPinBodySchema,
  memberMapsSchema,
  pinStatusOf,
} from "#src/maps/maps";

const issueOf = (result: { success: boolean; error?: { issues: { path: PropertyKey[] }[] } }) =>
  result.success ? null : result.error?.issues[0]?.path[0];

describe("map checks", () => {
  it("wants a map name in one language at least, and no other field", () => {
    expect(mapBodySchema.safeParse({ nameEn: "Floor 1" }).success).toBe(true);
    expect(mapBodySchema.safeParse({ nameAr: "الطابق الأول", nameEn: null }).success).toBe(true);
    expect(issueOf(mapBodySchema.safeParse({}))).toBe("name");
    expect(issueOf(mapBodySchema.safeParse({ nameEn: "   ", nameAr: "" }))).toBe("name");
    expect(mapBodySchema.safeParse({ nameEn: "x".repeat(61) }).success).toBe(false);
    expect(mapBodySchema.safeParse({ nameEn: "Floor", image: "a.png" }).success).toBe(false);
  });

  it("holds each pin kind to the fields it needs", () => {
    const at = { x: 0, y: 1000 };
    expect(mapPinBodySchema.safeParse({ kind: "booth", nameEn: "Booth 12", ...at }).success).toBe(
      true,
    );
    expect(issueOf(mapPinBodySchema.safeParse({ kind: "section", ...at }))).toBe("name");
    expect(issueOf(mapPinBodySchema.safeParse({ kind: "amenity", ...at }))).toBe("amenity");
    for (const amenity of MAP_AMENITIES) {
      expect(mapPinBodySchema.safeParse({ kind: "amenity", amenity, ...at }).success).toBe(true);
    }
    expect(issueOf(mapPinBodySchema.safeParse({ kind: "quest", ...at }))).toBe("questId");
    expect(
      mapPinBodySchema.safeParse({ kind: "quest", questId: crypto.randomUUID(), ...at }).success,
    ).toBe(true);
  });

  it("keeps a pin on the board, in whole thousandths", () => {
    const pin = { kind: "amenity", amenity: "food" } as const;
    expect(issueOf(mapPinBodySchema.safeParse({ ...pin, x: 1001, y: 0 }))).toBe("x");
    expect(issueOf(mapPinBodySchema.safeParse({ ...pin, x: 0, y: -1 }))).toBe("y");
    expect(issueOf(mapPinBodySchema.safeParse({ ...pin, x: 0.5, y: 0 }))).toBe("x");
    expect(mapPinBodySchema.safeParse({ ...pin, x: 1000, y: 0 }).success).toBe(true);
  });
});

describe("what a quest pin shows", () => {
  it("is done, open, or locked, whatever the reason for locked", () => {
    const shown = Object.fromEntries(MAP_QUEST_STATES.map((state) => [state, pinStatusOf(state)]));
    expect(shown).toEqual({
      done: "done",
      open: "open",
      locked: "locked",
      not_live: "locked",
      not_yet: "locked",
      closed: "locked",
    });
  });

  it("reads the player's maps with no position of their phone in them", () => {
    const parsed = memberMapsSchema.safeParse({
      maps: [{ id: crypto.randomUUID(), name: { ar: "الطابق", en: "Floor" }, pins: [] }],
      here: null,
    });
    expect(parsed.success).toBe(true);
    expect(Object.keys(memberMapsSchema.shape).sort()).toEqual(["here", "maps"]);
  });
});

describe("map words", () => {
  it("has every amenity and kind named in both languages", () => {
    for (const amenity of MAP_AMENITIES) {
      const key = amenityKey(amenity);
      expect(MESSAGES[key].ar.length, key).toBeGreaterThan(0);
      expect(MESSAGES[key].en.length, key).toBeGreaterThan(0);
    }
    for (const status of ["done", "open", "locked"]) {
      expect(MESSAGES[`mapsView.status.${status}` as keyof typeof MESSAGES].ar).not.toBe("");
    }
  });
});
