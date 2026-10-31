import { describe, expect, it } from "vitest";
import {
  domainsOf,
  draftsOf,
  fieldsBody,
  fieldsUnsaved,
  guestLines,
  kindsFor,
  moveDraft,
  needsLabel,
  needsOptions,
  newDraft,
  rulesDraftOf,
  rulesUnsaved,
  welcomeOf,
  type FieldDraft,
  type JoinFieldView,
  removesSavedField,
} from "#src/lib/joining.ts";

const VIEWS: JoinFieldView[] = [
  { id: "f1", kind: "full_name", label: { ar: null, en: null }, required: true, options: null },
  { id: "f2", kind: "custom", label: { ar: "القسم", en: null }, required: false, options: null },
  {
    id: "f3",
    kind: "custom",
    label: { ar: null, en: "Section" },
    required: true,
    options: [
      { id: "women", ar: "نساء", en: "Women" },
      { id: "men", ar: null, en: "Men" },
    ],
  },
];
const SAVED = draftsOf(VIEWS);

describe("the field editor", () => {
  it("reads saved fields as rows and offers each named kind once", () => {
    expect(SAVED[1]).toEqual({
      key: "f2",
      id: "f2",
      kind: "custom",
      labelAr: "القسم",
      labelEn: "",
      required: false,
      options: null,
    });
    expect(SAVED[2]?.options).toEqual([
      { key: "women", id: "women", ar: "نساء", en: "Women" },
      { key: "men", id: "men", ar: "", en: "Men" },
    ]);
    expect(kindsFor(SAVED, 0)).toContain("full_name");
    expect(kindsFor(SAVED, 1)).not.toContain("full_name");
    expect(kindsFor(SAVED, 1)).toContain("custom");
    expect(newDraft(SAVED, "n1")).toMatchObject({ key: "n1", id: undefined, kind: "company" });
    const allNamed = ["full_name", "company", "job_title", "department", "ticket_number"].map(
      (kind, at): FieldDraft => ({ ...SAVED[0], key: `k${at}`, kind }) as FieldDraft,
    );
    expect(newDraft(allNamed, "n2").kind).toBe("custom");
  });

  it("moves rows within the list only", () => {
    expect(moveDraft(SAVED, 1, -1).map((row) => row.key)).toEqual(["f2", "f1", "f3"]);
    expect(moveDraft(SAVED, 0, 1).map((row) => row.key)).toEqual(["f2", "f1", "f3"]);
    expect(moveDraft(SAVED, 0, -1).map((row) => row.key)).toEqual(["f1", "f2", "f3"]);
    expect(moveDraft(SAVED, 2, 1).map((row) => row.key)).toEqual(["f1", "f2", "f3"]);
  });

  it("sends a label only for a custom field and an id only for a saved one", () => {
    const rows: FieldDraft[] = [
      ...SAVED,
      {
        key: "n",
        id: undefined,
        kind: "company",
        labelAr: "x",
        labelEn: "",
        required: true,
        options: null,
      },
    ];
    const withNew = rows.map((row) =>
      row.id === "f3"
        ? {
            ...row,
            options: [...(row.options ?? []), { key: "o", id: undefined, ar: "أطفال", en: " " }],
          }
        : row,
    );
    expect(fieldsBody(3, withNew)).toEqual({
      version: 3,
      fields: [
        { id: "f1", kind: "full_name", required: true },
        { id: "f2", kind: "custom", label: { ar: "القسم" }, required: false, options: null },
        {
          id: "f3",
          kind: "custom",
          label: { en: "Section" },
          required: true,
          options: [
            { id: "women", ar: "نساء", en: "Women" },
            { id: "men", en: "Men" },
            { ar: "أطفال" },
          ],
        },
        { kind: "company", required: true },
      ],
    });
    expect(needsLabel({ ...SAVED[1], labelAr: " " } as FieldDraft)).toBe(true);
    expect(needsLabel(SAVED[1] as FieldDraft)).toBe(false);
    expect(needsLabel({ ...SAVED[0], labelAr: "" } as FieldDraft)).toBe(false);
  });

  it("needs two named options on a choice field, and none on another", () => {
    const choice = SAVED[2] as FieldDraft;
    expect(needsOptions(choice)).toBe(false);
    expect(needsOptions({ ...choice, options: choice.options?.slice(0, 1) ?? [] })).toBe(true);
    expect(
      needsOptions({
        ...choice,
        options: [...(choice.options ?? []), { key: "x", id: undefined, ar: " ", en: "" }],
      }),
    ).toBe(true);
    expect(needsOptions(SAVED[1] as FieldDraft)).toBe(false);
    expect(needsOptions({ ...choice, kind: "company" })).toBe(false);
  });
});

describe("the rules and the guest list", () => {
  it("splits domains on lines, commas and spaces", () => {
    expect(domainsOf(" acme.sa\n\nacme.com, other.sa،x.sa ")).toEqual([
      "acme.sa",
      "acme.com",
      "other.sa",
      "x.sa",
    ]);
    expect(domainsOf("  ")).toEqual([]);
  });

  it("reads the welcome amount: empty is none, whole numbers 1 to 100 000", () => {
    expect(welcomeOf(" ")).toBeNull();
    expect(welcomeOf("50")).toBe(50);
    expect(welcomeOf("100000")).toBe(100_000);
    for (const bad of ["0", "100001", "1.5", "-3", "ten"]) {
      expect(welcomeOf(bad), bad).toBe("invalid");
    }
  });

  it("keeps the pasted lines in place, without trailing empty ones", () => {
    expect(guestLines("a\r\n\r\nb\rc\n\n  \n")).toEqual(["a", "", "b", "c"]);
    expect(guestLines("")).toEqual([]);
  });
});

describe("removesSavedField", () => {
  it("is true only when a saved field is missing from the drafts", () => {
    expect(removesSavedField(VIEWS, SAVED)).toBe(false);
    expect(removesSavedField(VIEWS, SAVED.slice(1))).toBe(true);
    expect(removesSavedField([], [])).toBe(false);
  });
});

describe("fieldsUnsaved", () => {
  it("is false for the rows as the saved fields fill them", () => {
    expect(fieldsUnsaved(SAVED, VIEWS)).toBe(false);
  });

  it("is true for a label typed, a row added, removed, moved or a choice added", () => {
    const [first, second, third] = SAVED as [FieldDraft, FieldDraft, FieldDraft];
    expect(fieldsUnsaved([first, { ...second, labelEn: "Section" }, third], VIEWS)).toBe(true);
    expect(fieldsUnsaved([...SAVED, newDraft(SAVED, "n1")], VIEWS)).toBe(true);
    expect(fieldsUnsaved(SAVED.slice(1), VIEWS)).toBe(true);
    expect(fieldsUnsaved(moveDraft(SAVED, 0, 1), VIEWS)).toBe(true);
    const options = [...(third.options ?? []), { key: "o9", id: undefined, ar: "", en: "Other" }];
    expect(fieldsUnsaved([first, second, { ...third, options }], VIEWS)).toBe(true);
  });

  it("is false when only the typed spacing around a label differs", () => {
    const [first, second, third] = SAVED as [FieldDraft, FieldDraft, FieldDraft];
    expect(fieldsUnsaved([first, { ...second, labelEn: "   " }, third], VIEWS)).toBe(false);
  });
});

describe("rulesUnsaved", () => {
  const saved = rulesDraftOf({
    guestListOnly: false,
    emailDomains: ["acme.sa", "riyadh.test"],
    welcomePoints: 50,
  });

  it("reads the rules as the form types them", () => {
    expect(saved).toEqual({
      guestListOnly: false,
      domains: "acme.sa\nriyadh.test",
      welcome: "50",
    });
    expect(rulesDraftOf({ guestListOnly: true, emailDomains: [], welcomePoints: null })).toEqual({
      guestListOnly: true,
      domains: "",
      welcome: "",
    });
  });

  it("is false for the rules as saved, whatever the spacing between domains or around the amount", () => {
    expect(rulesUnsaved(saved, saved)).toBe(false);
    expect(
      rulesUnsaved({ ...saved, domains: " acme.sa, riyadh.test \n", welcome: " 50 " }, saved),
    ).toBe(false);
  });

  it.each([
    ["the guest list switch", { guestListOnly: true }],
    ["a domain added", { domains: "acme.sa\nriyadh.test\nnew.sa" }],
    ["the amount", { welcome: "60" }],
    ["the amount cleared", { welcome: "" }],
  ])("is true for %s", (_name, change) => {
    expect(rulesUnsaved({ ...saved, ...change }, saved)).toBe(true);
  });
});
