import { describe, expect, it } from "vitest";
import {
  EMPTY_EQUIPMENT,
  ITEM_KINDS,
  equipmentSchema,
  itemSchema,
  lockerEntrySchema,
  lockerSchema,
  profilePatchSchema,
  publicProfileSchema,
} from "#src/players/items";

const UUID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const item = {
  id: "frame-01",
  kind: "frame",
  name: { ar: "إطار الرحلة", en: "Journey frame" },
  visualKey: "frame-01",
};
const text = (length: number) => "a".repeat(length);

describe("itemSchema", () => {
  it("keeps every field of a valid item", () => {
    expect(itemSchema.parse(item)).toEqual(item);
    expect(itemSchema.parse({ ...item, visualKey: null })).toEqual({ ...item, visualKey: null });
  });

  it("names the three kinds and refuses any other", () => {
    expect(ITEM_KINDS).toEqual(["character", "frame", "title"]);
    for (const kind of ITEM_KINDS)
      expect(itemSchema.safeParse({ ...item, kind }).success).toBe(true);
    for (const kind of ["badge", "", undefined])
      expect(itemSchema.safeParse({ ...item, kind }).success).toBe(false);
  });

  it("bounds the id to 1..64 characters", () => {
    for (const id of [text(1), text(64)])
      expect(itemSchema.safeParse({ ...item, id }).success).toBe(true);
    for (const id of ["", text(65), 7])
      expect(itemSchema.safeParse({ ...item, id }).success).toBe(false);
  });

  it("bounds each language of the name to 1..60 characters", () => {
    for (const language of ["ar", "en"] as const) {
      for (const value of [text(1), text(60)])
        expect(
          itemSchema.safeParse({ ...item, name: { ...item.name, [language]: value } }).success,
        ).toBe(true);
      for (const value of ["", text(61)])
        expect(
          itemSchema.safeParse({ ...item, name: { ...item.name, [language]: value } }).success,
        ).toBe(false);
    }
    expect(itemSchema.safeParse({ ...item, name: { ar: "إطار" } }).success).toBe(false);
  });

  it("allows no art key, a short one and at most 40 characters", () => {
    for (const visualKey of [null, "chest", text(40)])
      expect(itemSchema.safeParse({ ...item, visualKey }).success).toBe(true);
    for (const visualKey of [text(41), 3, undefined])
      expect(itemSchema.safeParse({ ...item, visualKey }).success).toBe(false);
  });
});

describe("equipmentSchema", () => {
  it("reads three slots, each an item or empty", () => {
    const equipment = { character: item, frame: null, title: item };
    expect(equipmentSchema.parse(equipment)).toEqual(equipment);
    expect(equipmentSchema.parse(EMPTY_EQUIPMENT)).toEqual({
      character: null,
      frame: null,
      title: null,
    });
  });

  it("starts with every slot empty", () => {
    expect(EMPTY_EQUIPMENT).toEqual({ character: null, frame: null, title: null });
  });

  it("refuses a missing slot and a malformed item", () => {
    expect(equipmentSchema.safeParse({ character: null, frame: null }).success).toBe(false);
    expect(
      equipmentSchema.safeParse({ ...EMPTY_EQUIPMENT, frame: { ...item, kind: "badge" } }).success,
    ).toBe(false);
  });
});

const accepts = (value: unknown) => profilePatchSchema.safeParse(value).success;

describe("profilePatchSchema", () => {
  it("keeps what a valid patch names", () => {
    const patch = { username: "sara_k", frameId: "frame-01", titleId: null };
    expect(profilePatchSchema.parse(patch)).toEqual(patch);
  });

  it("refuses an empty patch and any field it does not know", () => {
    expect(accepts({})).toBe(false);
    expect(accepts({ username: "sara", level: 9 })).toBe(false);
    expect(accepts({ playerId: "forged" })).toBe(false);
  });

  it("bounds the username to 1..120 characters", () => {
    for (const username of [text(1), text(120)]) expect(accepts({ username })).toBe(true);
    for (const username of ["", text(121), 5]) expect(accepts({ username })).toBe(false);
  });

  it("takes each of the six avatars and nothing else", () => {
    for (const avatar of ["falcon", "fox", "camel", "owl", "lantern", "explorer-hat"])
      expect(accepts({ avatar })).toBe(true);
    for (const avatar of ["", "tiger", "Falcon", null]) expect(accepts({ avatar })).toBe(false);
  });

  it.each(["characterId", "frameId", "titleId"])(
    "bounds %s to 1..64 characters or null",
    (field) => {
      for (const value of [text(1), text(64), null]) expect(accepts({ [field]: value })).toBe(true);
      for (const value of ["", text(65), 4]) expect(accepts({ [field]: value })).toBe(false);
    },
  );

  it("lets an avatar travel with any slot but the character, which it replaces", () => {
    expect(accepts({ avatar: "fox" })).toBe(true);
    expect(accepts({ characterId: "starter-owl" })).toBe(true);
    expect(accepts({ avatar: "fox", frameId: "frame-01", titleId: null, username: "sara" })).toBe(
      true,
    );
    expect(accepts({ avatar: "fox", characterId: "starter-owl" })).toBe(false);
    expect(accepts({ avatar: "fox", characterId: null })).toBe(false);
  });
});

describe("lockerEntrySchema", () => {
  const level = {
    item,
    earnedAt: "2030-01-01T10:00:00.000000Z",
    source: { kind: "level", level: 3 },
    seen: false,
  };
  const event = {
    ...level,
    source: { kind: "event", event: { id: UUID, name: { ar: "مهرجان", en: "Fest" } } },
    seen: true,
  };

  it("keeps an entry earned at a level and one earned at an event", () => {
    expect(lockerEntrySchema.parse(level)).toEqual(level);
    expect(lockerEntrySchema.parse(event)).toEqual(event);
  });

  it("refuses a source of another kind or with the wrong fields", () => {
    for (const source of [
      { kind: "purchase", level: 3 },
      { kind: "level", level: 0 },
      { kind: "level", level: 1.5 },
      { kind: "level" },
      { kind: "event", event: { id: "not-a-uuid", name: { ar: "ا", en: "A" } } },
      { kind: "event", event: { id: UUID, name: { ar: "ا" } } },
      { kind: "event", event: { id: UUID } },
      { kind: "event" },
      {},
    ])
      expect(lockerEntrySchema.safeParse({ ...level, source }).success).toBe(false);
  });

  it("needs the time, the item and the seen flag", () => {
    expect(lockerEntrySchema.safeParse({ ...level, seen: "no" }).success).toBe(false);
    expect(lockerEntrySchema.safeParse({ ...level, earnedAt: 5 }).success).toBe(false);
    expect(lockerEntrySchema.safeParse({ ...level, item: { ...item, id: "" } }).success).toBe(
      false,
    );
  });
});

describe("lockerSchema", () => {
  it("keeps a page of entries and its cursor", () => {
    const entry = {
      item,
      earnedAt: "2030-01-01T10:00:00.000000Z",
      source: { kind: "level", level: 2 },
      seen: true,
    };
    expect(lockerSchema.parse({ items: [entry], nextCursor: "abc" })).toEqual({
      items: [entry],
      nextCursor: "abc",
    });
    expect(lockerSchema.parse({ items: [], nextCursor: null })).toEqual({
      items: [],
      nextCursor: null,
    });
  });

  it("refuses a page without its cursor, its list, or with a broken entry", () => {
    expect(lockerSchema.safeParse({ items: [] }).success).toBe(false);
    expect(lockerSchema.safeParse({ nextCursor: null }).success).toBe(false);
    expect(lockerSchema.safeParse({ items: [{}], nextCursor: null }).success).toBe(false);
  });
});

describe("publicProfileSchema", () => {
  const profile = {
    username: "sara_k",
    character: { starter: "falcon" },
    frame: null,
    title: item,
    level: { number: 3, title: { ar: "مستكشف", en: "Explorer" } },
    achievements: [],
    passport: [],
  };

  it("keeps a starter character and an owned one", () => {
    expect(publicProfileSchema.parse(profile)).toEqual(profile);
    const owned = { ...profile, character: { ...item, kind: "character" } };
    expect(publicProfileSchema.parse(owned)).toEqual(owned);
  });

  it("strips a field the allowlist does not name instead of passing it on", () => {
    const parsed = publicProfileSchema.parse({ ...profile, email: "private@example.com" });
    expect(parsed).toEqual(profile);
    expect(parsed).not.toHaveProperty("email");
  });

  it("refuses a character that is neither an item nor a starter", () => {
    for (const character of [{}, { starter: 5 }, { id: "x" }, null, "falcon"])
      expect(publicProfileSchema.safeParse({ ...profile, character }).success).toBe(false);
  });

  it("refuses a level that is not a positive whole number or has no title in both languages", () => {
    for (const level of [
      { number: 0, title: profile.level.title },
      { number: 1.5, title: profile.level.title },
      { number: 3 },
      { number: 3, title: { ar: "مستكشف" } },
      {},
    ])
      expect(publicProfileSchema.safeParse({ ...profile, level }).success).toBe(false);
  });

  it("needs a username and both slots, each an item or null", () => {
    expect(publicProfileSchema.safeParse({ ...profile, username: 5 }).success).toBe(false);
    expect(publicProfileSchema.safeParse({ ...profile, frame: undefined }).success).toBe(false);
    expect(publicProfileSchema.safeParse({ ...profile, title: { id: "x" } }).success).toBe(false);
  });

  it("needs the achievements and the passport, even when both are empty", () => {
    expect(publicProfileSchema.safeParse({ ...profile, achievements: undefined }).success).toBe(
      false,
    );
    expect(publicProfileSchema.safeParse({ ...profile, passport: undefined }).success).toBe(false);
  });

  it("refuses more than fifty stamps", () => {
    const stamp = {
      name: { ar: "مهرجان", en: "Fest" },
      date: "2030-01-01",
      city: null,
      rank: null,
    };
    expect(
      publicProfileSchema.safeParse({
        ...profile,
        passport: Array.from({ length: 51 }, () => ({ ...stamp })),
      }).success,
    ).toBe(false);
  });

  it("keeps the achievement tiers and the passport", () => {
    const withAll = {
      ...profile,
      achievements: [{ id: "quests-done", tier: null }],
      passport: [{ name: { ar: "مهرجان", en: "Fest" }, date: "2030-01-01", city: null, rank: 4 }],
    };
    expect(publicProfileSchema.parse(withAll)).toEqual(withAll);
  });
});
