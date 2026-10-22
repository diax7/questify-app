import { describe, expect, it } from "vitest";
import {
  domainsOf,
  draftsOf,
  fieldsBody,
  guestLines,
  kindsFor,
  moveDraft,
  needsLabel,
  newDraft,
  welcomeOf,
  type FieldDraft,
} from "#src/lib/joining.ts";

const SAVED = draftsOf([
  { id: "f1", kind: "full_name", label: { ar: null, en: null }, required: true },
  { id: "f2", kind: "custom", label: { ar: "القسم", en: null }, required: false },
]);

describe("the field editor", () => {
  it("reads saved fields as rows and offers each named kind once", () => {
    expect(SAVED[1]).toEqual({
      key: "f2",
      id: "f2",
      kind: "custom",
      labelAr: "القسم",
      labelEn: "",
      required: false,
    });
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
    expect(moveDraft(SAVED, 1, -1).map((row) => row.key)).toEqual(["f2", "f1"]);
    expect(moveDraft(SAVED, 0, 1).map((row) => row.key)).toEqual(["f2", "f1"]);
    expect(moveDraft(SAVED, 0, -1).map((row) => row.key)).toEqual(["f1", "f2"]);
    expect(moveDraft(SAVED, 1, 1).map((row) => row.key)).toEqual(["f1", "f2"]);
  });

  it("sends a label only for a custom field and an id only for a saved one", () => {
    const rows: FieldDraft[] = [
      ...SAVED,
      { key: "n", id: undefined, kind: "company", labelAr: "x", labelEn: "", required: true },
    ];
    expect(fieldsBody(3, rows)).toEqual({
      version: 3,
      fields: [
        { id: "f1", kind: "full_name", required: true },
        { id: "f2", kind: "custom", label: { ar: "القسم" }, required: false },
        { kind: "company", required: true },
      ],
    });
    expect(needsLabel({ ...SAVED[1], labelAr: " " } as FieldDraft)).toBe(true);
    expect(needsLabel(SAVED[1] as FieldDraft)).toBe(false);
    expect(needsLabel({ ...SAVED[0], labelAr: "" } as FieldDraft)).toBe(false);
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
