import { describe, expect, it } from "vitest";
import { cleanAnswers } from "#src/join/routes";
import {
  cleanDomains,
  cleanFields,
  cleanTag,
  makeOptionId,
  maskGuest,
  parseGuest,
  parseGuests,
  type FieldRecord,
} from "#src/join/setup";

const KEPT: FieldRecord = {
  id: "11111111-1111-4111-8111-111111111111",
  kind: "company",
  label: { ar: null, en: null },
  required: true,
  options: null,
};
const CHOICE: FieldRecord = {
  id: "33333333-3333-4333-8333-333333333333",
  kind: "custom",
  label: { ar: null, en: "Section" },
  required: true,
  options: [
    { id: "women", ar: "نساء", en: "Women" },
    { id: "men", ar: "رجال", en: "Men" },
  ],
};

describe("guest tags and option ids", () => {
  it("trims a tag, takes none for blank, and refuses a long one or control characters", () => {
    expect(cleanTag(" VIP ")).toBe("VIP");
    expect(cleanTag(undefined)).toBeNull();
    expect(cleanTag("   ")).toBeNull();
    expect(cleanTag("ب".repeat(30))).toBe("ب".repeat(30));
    expect(cleanTag("ب".repeat(31))).toBeUndefined();
    expect(cleanTag("a	b")).toBeUndefined();
  });

  it("makes eight-character ids of letters and digits", () => {
    const made = new Set(Array.from({ length: 50 }, makeOptionId));
    expect(made.size).toBe(50);
    for (const id of made) {
      expect(id).toMatch(/^[a-z0-9]{8}$/);
    }
  });
});

describe("cleanDomains", () => {
  it("lower-cases, drops a leading @ and repeats, and keeps the order", () => {
    expect(cleanDomains([" @ACME.sa ", "acme.sa", "xn--mgbh0fb.sa"])).toEqual([
      "acme.sa",
      "xn--mgbh0fb.sa",
    ]);
    expect(cleanDomains([])).toEqual([]);
  });

  it("refuses anything that is not an exact domain, and more than ten", () => {
    for (const bad of [
      "acme",
      "a@acme.sa",
      "-acme.sa",
      "acme-.sa",
      "acme.s",
      `${"a".repeat(251)}.sa`,
    ]) {
      expect(cleanDomains([bad]), bad).toBeUndefined();
    }
    expect(cleanDomains([`${"a".repeat(250)}.sa`])).toHaveLength(1);
    expect(cleanDomains(Array.from({ length: 10 }, (_, n) => `d${n}.sa`))).toHaveLength(10);
    expect(cleanDomains(Array.from({ length: 11 }, (_, n) => `d${n}.sa`))).toBeUndefined();
  });
});

describe("parseGuest and parseGuests", () => {
  it("reads Saudi mobiles in their usual forms and emails with a dotted domain", () => {
    expect(parseGuest("05 1234 5678")).toEqual({ kind: "phone", value: "+966512345678" });
    expect(parseGuest("٠٥١٢٣٤٥٦٧٨")).toEqual({ kind: "phone", value: "+966512345678" });
    expect(parseGuest(" Sara@Acme.SA ")).toEqual({ kind: "email", value: "sara@acme.sa" });
    expect(parseGuest("a@mail.acme.sa")).toEqual({ kind: "email", value: "a@mail.acme.sa" });
    for (const bad of [
      "a@b",
      "a@b.",
      "a@.b",
      "a@acme.sa.",
      "a@.acme.sa",
      "a@acme..sa",
      "plain",
      "+14155550100",
      "a b@c.sa",
      "a@b@c.sa",
    ]) {
      expect(parseGuest(bad), bad).toBeUndefined();
    }
  });

  it("keeps each guest once, skips empty lines and reports the rest by line, shortened", () => {
    const long = `x${"y".repeat(80)}`;
    expect(parseGuests(["0512345678", "", "+966512345678", "  ", long, "a@acme.sa"])).toEqual({
      guests: [
        { kind: "phone", value: "+966512345678" },
        { kind: "email", value: "a@acme.sa" },
      ],
      invalid: [{ line: 5, text: long.slice(0, 60) }],
    });
  });
});

describe("maskGuest", () => {
  it("shows a phone's last four digits and an email's first letter and domain", () => {
    expect(maskGuest("phone", "+966512345678")).toBe("•••• 5678");
    expect(maskGuest("email", "sara@acme.sa")).toBe("s•••@acme.sa");
  });
});

describe("cleanFields", () => {
  it("cleans a custom field's options, keeping ids and making new ones; null for none", () => {
    expect(
      cleanFields(
        [
          {
            id: CHOICE.id,
            kind: "custom",
            label: { en: "Section" },
            required: true,
            options: [{ id: "women", en: " Ladies " }, { id: "men", ar: "رجال" }, { en: "Kids" }],
          },
          { kind: "custom", label: { en: "Team" }, required: false, options: null },
        ],
        [CHOICE],
        () => "kids1",
      ),
    ).toEqual([
      {
        id: CHOICE.id,
        kind: "custom",
        label: { ar: null, en: "Section" },
        required: true,
        options: [
          { id: "women", ar: null, en: "Ladies" },
          { id: "men", ar: "رجال", en: null },
          { id: "kids1", ar: null, en: "Kids" },
        ],
      },
      { id: "", kind: "custom", label: { ar: null, en: "Team" }, required: false, options: null },
    ]);
  });

  it("refuses options on a named kind and options that break a rule", () => {
    const two = [{ en: "A" }, { en: "B" }];
    expect(cleanFields([{ kind: "company", required: true, options: two }], [])).toBeUndefined();
    expect(
      cleanFields(
        [{ kind: "custom", label: { en: "X" }, required: true, options: [{ en: "A" }] }],
        [],
      ),
    ).toBeUndefined();
    expect(
      cleanFields(
        [{ kind: "custom", label: { en: "X" }, required: true, options: two }],
        [],
        makeOptionId,
      ),
    ).toHaveLength(1);
  });

  it("keeps the order, trims custom labels and drops labels from the named kinds", () => {
    expect(
      cleanFields(
        [
          { id: KEPT.id, kind: "company", label: { en: "ignored" }, required: false },
          { kind: "custom", label: { ar: "  القسم ", en: " " }, required: true },
        ],
        [KEPT],
      ),
    ).toEqual([
      {
        id: KEPT.id,
        kind: "company",
        label: { ar: null, en: null },
        required: false,
        options: null,
      },
      { id: "", kind: "custom", label: { ar: "القسم", en: null }, required: true, options: null },
    ]);
    expect(cleanFields([], [KEPT])).toEqual([]);
  });

  it("refuses a repeated kind, a custom field without a label, a long label, and a foreign or changed id", () => {
    const refused = [
      [
        { kind: "company", required: true },
        { kind: "company", required: false },
      ],
      [{ kind: "custom", label: { ar: " ", en: "" }, required: true }],
      [{ kind: "custom", required: true }],
      [{ kind: "custom", label: { en: "x".repeat(61) }, required: true }],
      [{ id: "22222222-2222-4222-8222-222222222222", kind: "company", required: true }],
      [{ id: KEPT.id, kind: "department", required: true }],
      [
        { id: KEPT.id, kind: "company", required: true },
        { id: KEPT.id, kind: "company", required: true },
      ],
    ] as const;
    for (const input of refused) {
      expect(cleanFields(input, [KEPT]), JSON.stringify(input)).toBeUndefined();
    }
    expect(
      cleanFields([{ kind: "custom", label: { en: "x".repeat(60) }, required: true }], []),
    ).toHaveLength(1);
    const two = [
      { kind: "custom", label: { en: "A" }, required: true },
      { kind: "custom", label: { en: "B" }, required: true },
    ] as const;
    expect(cleanFields(two, [])).toHaveLength(2);
    const six = Array.from({ length: 6 }, () => ({
      kind: "custom" as const,
      label: { en: "A" },
      required: false,
    }));
    expect(cleanFields(six, [])).toBeUndefined();
    expect(cleanFields(six.slice(0, 5), [])).toHaveLength(5);
  });
});

describe("cleanAnswers", () => {
  it("trims and normalizes each answer and leaves out the blank ones", () => {
    expect(cleanAnswers({ a: "  Acme ", b: "   ", c: "é" })).toEqual({ a: "Acme", c: "é" });
    expect(cleanAnswers(undefined)).toEqual({});
  });
});
