import { describe, expect, it } from "vitest";
import { MESSAGES } from "#src/i18n/messages";
import { JOIN_FIELD_KINDS, joinFieldKindKey, joinFieldLabel } from "#src/join/fields";

describe("join fields", () => {
  it("names every kind in both languages", () => {
    for (const kind of JOIN_FIELD_KINDS) {
      const words = MESSAGES[joinFieldKindKey(kind)];
      expect(words.ar.length, kind).toBeGreaterThan(0);
      expect(words.en.length, kind).toBeGreaterThan(0);
    }
    expect(new Set(JOIN_FIELD_KINDS.map(joinFieldKindKey)).size).toBe(JOIN_FIELD_KINDS.length);
  });

  it("uses a custom label, the other language's when one is empty, else the kind's words", () => {
    const custom = { kind: "custom", label: { ar: "القسم", en: null } };
    expect(joinFieldLabel(custom, "ar")).toBe("القسم");
    expect(joinFieldLabel(custom, "en")).toBe("القسم");
    expect(joinFieldLabel({ kind: "custom", label: { ar: "", en: "Wing" } }, "ar")).toBe("Wing");
    const named = { kind: "job_title", label: { ar: null, en: null } };
    expect(joinFieldLabel(named, "en")).toBe("Job title");
    expect(joinFieldLabel(named, "ar")).toBe("المسمى الوظيفي");
    expect(joinFieldLabel({ kind: "badge_color", label: { ar: null, en: null } }, "en")).toBe(
      MESSAGES["joinField.custom"].en,
    );
  });
});
