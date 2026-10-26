import { describe, expect, it } from "vitest";
import { souvenirBodySchema, souvenirListSchema, souvenirRuleSchema } from "#src/souvenirs";

const body = {
  kind: "frame",
  name: { ar: "إطار الرحلة", en: "Journey frame" },
  visualKey: "frame-01",
  audience: "joined",
};
describe("souvenir configuration", () => {
  it("accepts every shipped frame and all three item kinds without accepting arbitrary art", () => {
    for (let index = 1; index <= 14; index += 1)
      expect(
        souvenirBodySchema.safeParse({
          ...body,
          visualKey: `frame-${String(index).padStart(2, "0")}`,
        }).success,
      ).toBe(true);
    expect(souvenirBodySchema.safeParse({ ...body, kind: "title", visualKey: null }).success).toBe(
      true,
    );
    expect(
      souvenirBodySchema.safeParse({ ...body, kind: "character", visualKey: "chest" }).success,
    ).toBe(true);
    for (const visualKey of [null, "frame-00", "frame-15", "chest", "https://remote/art"])
      expect(souvenirBodySchema.safeParse({ ...body, visualKey }).success).toBe(false);
  });
  it("rejects forged fields and invalid audience/target combinations", () => {
    for (const patch of [
      { playerId: "forged" },
      { source: "level" },
      { kind: "other" },
      { audience: "rank" },
      { audience: "rank", rankFrom: 3, rankTo: 1 },
      { audience: "rank", rankFrom: 1, rankTo: 101 },
      { audience: "category" },
      { categoryId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa" },
      { name: { ar: "", en: "Name" } },
    ]) {
      expect(souvenirBodySchema.safeParse({ ...body, ...patch }).success).toBe(false);
    }
  });
  it("refuses control and direction characters in public names and keeps ordinary Arabic", () => {
    for (const ar of ["إطار‮الرحلة", "إطار\u0000", "إطار\u0007الرحلة", "إطار⁦الرحلة"])
      expect(souvenirBodySchema.safeParse({ ...body, name: { ar, en: "Frame" } }).success).toBe(
        false,
      );
    expect(
      souvenirBodySchema.safeParse({ ...body, name: { ar: "Frame", en: "Frame two" } }).success,
    ).toBe(false);
    expect(
      souvenirBodySchema.safeParse({
        ...body,
        name: { ar: "بطل هاكاثون 2026", en: "Hackathon hero" },
      }).success,
    ).toBe(true);
  });
});

const CATEGORY = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const rank = { ...body, audience: "rank" };
/** What a refused body reports: each issue's code, path and message, so a test sees which rule spoke. */
const refusal = (input: unknown) => {
  const result = souvenirBodySchema.safeParse(input);
  return result.success
    ? null
    : result.error.issues.map((one) => ({ code: one.code, path: one.path, message: one.message }));
};
const named = (ar: string, en = "Frame") => ({ ...body, name: { ar, en } });
const custom = (path: string) => ({ code: "custom", path: [path], message: "Invalid input" });

describe("souvenir names", () => {
  it("trims the name in both languages and keeps the defaults of the optional fields", () => {
    const parsed = souvenirBodySchema.parse({
      ...body,
      name: { ar: "  إطار  ", en: " Frame\t" },
    });
    expect(parsed).toEqual({
      kind: "frame",
      name: { ar: "إطار", en: "Frame" },
      visualKey: "frame-01",
      audience: "joined",
      categoryId: null,
      rankFrom: null,
      rankTo: null,
    });
  });

  it("bounds a name to 1..60 characters after trimming", () => {
    expect(souvenirBodySchema.safeParse(named("a")).success).toBe(true);
    expect(souvenirBodySchema.safeParse(named("a".repeat(60))).success).toBe(true);
    expect(souvenirBodySchema.safeParse(named(`  ${"a".repeat(60)}  `)).success).toBe(true);
    expect(souvenirBodySchema.safeParse(named("a".repeat(61))).success).toBe(false);
    expect(souvenirBodySchema.safeParse(named("   ")).success).toBe(false);
    expect(souvenirBodySchema.safeParse(named("Frame", "   ")).success).toBe(false);
  });

  it("says why a name with a direction character is refused", () => {
    expect(refusal({ ...body, name: { ar: "إطار‮الرحلة", en: "Frame" } })).toEqual([
      {
        code: "custom",
        path: ["name", "ar"],
        message: "must hold no control or direction characters",
      },
    ]);
  });
});

describe("souvenir audience", () => {
  it("takes each of the four audiences with its own target", () => {
    const audiences = [
      { audience: "joined" },
      { audience: "all" },
      { audience: "category", categoryId: CATEGORY },
      { audience: "rank", rankFrom: 1, rankTo: 10 },
    ];
    for (const audience of audiences)
      expect(souvenirBodySchema.parse({ ...body, ...audience })).toMatchObject(audience);
    for (const audience of ["", "everyone", "Joined", null])
      expect(souvenirBodySchema.safeParse({ ...body, audience }).success).toBe(false);
  });

  it("ties the category to the category audience, both ways", () => {
    expect(refusal({ ...body, audience: "category" })).toEqual([custom("categoryId")]);
    expect(refusal({ ...body, categoryId: CATEGORY })).toEqual([custom("categoryId")]);
    expect(refusal({ ...body, audience: "category", categoryId: CATEGORY })).toBeNull();
    expect(
      souvenirBodySchema.safeParse({ ...body, audience: "category", categoryId: "not-a-uuid" })
        .success,
    ).toBe(false);
  });

  it("takes a rank range of one place or more, in order", () => {
    for (const [rankFrom, rankTo] of [
      [1, 100],
      [5, 5],
      [7, 9],
    ])
      expect(refusal({ ...rank, rankFrom, rankTo })).toBeNull();
  });

  it("refuses a rank range that is open or reversed, naming the end place", () => {
    for (const [rankFrom, rankTo] of [
      [null, 5],
      [3, null],
      [null, null],
      [6, 5],
    ])
      expect(refusal({ ...rank, rankFrom, rankTo })).toEqual([custom("rankTo")]);
  });

  it("refuses a rank place outside 1..100 or not whole", () => {
    for (const [rankFrom, rankTo] of [
      [0, 5],
      [101, 101],
      [1.5, 5],
      [1, 0],
      [1, 101],
      [1, 2.5],
    ])
      expect(souvenirBodySchema.safeParse({ ...rank, rankFrom, rankTo }).success).toBe(false);
  });

  it("refuses a rank range on any other audience, naming the start place", () => {
    for (const range of [{ rankFrom: 1 }, { rankTo: 5 }, { rankFrom: 1, rankTo: 5 }])
      for (const audience of ["joined", "all"])
        expect(refusal({ ...body, audience, ...range })).toEqual([custom("rankFrom")]);
  });
});

describe("souvenir art", () => {
  it("allows a title no art, a character only the chest and a frame only the 14 frames", () => {
    expect(refusal({ ...body, kind: "title", visualKey: null })).toBeNull();
    expect(refusal({ ...body, kind: "character", visualKey: "chest" })).toBeNull();
    expect(refusal({ ...body, kind: "frame", visualKey: "frame-14" })).toBeNull();
  });

  it("names the art as the field at fault when it does not fit the kind", () => {
    for (const patch of [
      { kind: "title", visualKey: "frame-01" },
      { kind: "title", visualKey: "chest" },
      { kind: "character", visualKey: null },
      { kind: "character", visualKey: "frame-01" },
      { kind: "character", visualKey: "Chest" },
      { kind: "frame", visualKey: null },
      { kind: "frame", visualKey: "frame-1" },
      { kind: "frame", visualKey: "frame-15" },
      { kind: "frame", visualKey: "xframe-01" },
      { kind: "frame", visualKey: "frame-011" },
    ])
      expect(refusal({ ...body, ...patch })).toEqual([custom("visualKey")]);
  });
});

describe("souvenir rule and list answers", () => {
  const item = {
    id: "frame-01",
    kind: "frame",
    name: { ar: "إطار", en: "Frame" },
    visualKey: "frame-01",
  };
  const rule = {
    id: CATEGORY,
    item,
    audience: "rank",
    categoryId: null,
    rankFrom: 1,
    rankTo: 10,
    status: "active",
    targetCount: 12,
    targetIds: [CATEGORY],
    granted: 3,
    waitingForResults: false,
  };

  it("keeps every field of a rule", () => {
    expect(souvenirRuleSchema.parse(rule)).toEqual(rule);
    const category = {
      ...rule,
      audience: "category",
      categoryId: CATEGORY,
      rankFrom: null,
      rankTo: null,
    };
    expect(souvenirRuleSchema.parse(category)).toEqual(category);
  });

  it("takes each audience and each status and refuses any other", () => {
    for (const audience of ["joined", "category", "all", "rank"])
      expect(souvenirRuleSchema.safeParse({ ...rule, audience }).success).toBe(true);
    for (const status of ["draft", "active", "stopped"])
      expect(souvenirRuleSchema.safeParse({ ...rule, status }).success).toBe(true);
    for (const patch of [
      { audience: "" },
      { audience: "everyone" },
      { status: "" },
      { status: "paused" },
    ])
      expect(souvenirRuleSchema.safeParse({ ...rule, ...patch }).success).toBe(false);
  });

  it("refuses counts that are negative or fractional and ids that are not UUIDs", () => {
    for (const patch of [
      { targetCount: -1 },
      { targetCount: 1.5 },
      { granted: -1 },
      { granted: 0.5 },
      { id: "x" },
      { categoryId: "x" },
      { targetIds: ["x"] },
      { waitingForResults: "no" },
      { item: { ...item, kind: "badge" } },
    ])
      expect(souvenirRuleSchema.safeParse({ ...rule, ...patch }).success).toBe(false);
    expect(souvenirRuleSchema.safeParse({ ...rule, targetCount: 0, granted: 0 }).success).toBe(
      true,
    );
  });

  it("keeps a list with its counters and refuses a negative one", () => {
    const list = { rules: [rule], archived: false, due: 0, scanning: 2, failed: 1 };
    expect(souvenirListSchema.parse(list)).toEqual(list);
    for (const patch of [{ due: -1 }, { scanning: -1 }, { failed: 0.5 }, { archived: "no" }])
      expect(souvenirListSchema.safeParse({ ...list, ...patch }).success).toBe(false);
    expect(souvenirListSchema.safeParse({ ...list, rules: [{}] }).success).toBe(false);
  });
});
