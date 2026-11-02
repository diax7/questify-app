import { describe, expect, it } from "vitest";
import type { HelpAdmin } from "@questify/shared";
import {
  checkHelp,
  checkPublish,
  helpDraftOf,
  isHelpDirty,
  newHelpDraft,
  nextVersion,
  publishDraftOf,
  readHelp,
  readLegal,
} from "#src/lib/console-legal.ts";

const row: HelpAdmin = {
  id: "join",
  question: { ar: "كيف أنضم؟", en: "How do I join?" },
  answer: { ar: "امسح الرمز.", en: "Scan the code." },
  position: 2,
  published: true,
  updatedAt: "2026-11-02T10:00:00.000Z",
  revertible: false,
};

describe("nextVersion", () => {
  it("raises the last number", () => {
    expect(nextVersion("0.1")).toBe("0.2");
    expect(nextVersion("3")).toBe("4");
    expect(nextVersion("1.0.9")).toBe("1.0.10");
  });
});

describe("checkPublish", () => {
  it("is not ready until both texts are written", () => {
    const draft = publishDraftOf("0.1");
    expect(draft.version).toBe("0.2");
    expect(checkPublish(draft).ok).toBe(false);
    const ready = checkPublish({ ...draft, ar: "نص", en: "Text", note: "  " });
    expect(ready).toEqual({ ok: true, doc: { version: "0.2", text: { ar: "نص", en: "Text" } } });
  });

  it("names the field that is wrong", () => {
    const wrong = checkPublish({ version: "v2", ar: "English", en: "Text", note: "" });
    expect(wrong.ok).toBe(false);
    expect(wrong.ok ? [] : [...wrong.fields].toSorted()).toEqual(["text.ar", "version"]);
  });
});

describe("help drafts", () => {
  it("starts a new article last, hidden", () => {
    expect(newHelpDraft([row])).toMatchObject({ id: "", position: "3", published: false });
    expect(newHelpDraft([])).toMatchObject({ position: "1" });
  });

  it("turns a draft into the document the API takes, and back", () => {
    const draft = helpDraftOf(row);
    expect(checkHelp(draft)).toMatchObject({ ok: true, doc: { position: 2, published: true } });
    expect(isHelpDirty(row, draft)).toBe(false);
    expect(isHelpDirty(row, { ...draft, answerEn: "Scan it." })).toBe(true);
    expect(isHelpDirty(row, { ...draft, published: false })).toBe(true);
  });

  it("refuses a half-written language and a position that is not a whole number", () => {
    const draft = helpDraftOf(row);
    const half = checkHelp({ ...draft, answerAr: "" });
    expect(half.ok).toBe(false);
    expect(half.ok ? [] : [...half.fields]).toContain("answer.ar");
    expect(checkHelp({ ...draft, position: "1.5" }).ok).toBe(false);
    expect(checkHelp({ ...draft, position: "" }).ok).toBe(false);
  });
});

describe("readers", () => {
  it("answer undefined for a body that is not the expected shape", () => {
    expect(readHelp({ articles: [{ id: "x" }] })).toBeUndefined();
    expect(readHelp(undefined)).toBeUndefined();
    expect(readLegal({ documents: [{ document: "passwords", versions: [] }] })).toBeUndefined();
    expect(readHelp({ articles: [row] })).toEqual([row]);
    expect(readLegal({ documents: [] })).toEqual([]);
  });
});
