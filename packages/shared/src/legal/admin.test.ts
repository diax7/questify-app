import { describe, expect, it } from "vitest";
import { helpDocSchema, legalPublishSchema, shownHelp } from "#src/legal/admin";

const article = {
  question: { ar: "كيف أنضم؟", en: "How do I join?" },
  answer: { ar: "امسح الرمز.", en: "Scan the code." },
  position: 1,
  published: true,
};

describe("legalPublishSchema", () => {
  const valid = { version: "1.2", text: { ar: "نص", en: "Text" } };

  it("takes a version, both texts and an optional note", () => {
    expect(legalPublishSchema.safeParse(valid).success).toBe(true);
    expect(legalPublishSchema.safeParse({ ...valid, note: "Counsel's edit" }).success).toBe(true);
  });

  it.each([
    ["a version with a letter", { ...valid, version: "v1" }],
    ["four numbers", { ...valid, version: "1.2.3.4" }],
    ["an Arabic text without Arabic", { ...valid, text: { ar: "English", en: "Text" } }],
    ["an empty English text", { ...valid, text: { ar: "نص", en: "  " } }],
    ["Eastern Arabic digits", { ...valid, text: { ar: "المادة ١", en: "Text" } }],
    ["a control character", { ...valid, text: { ar: "نص", en: "Te\u0001xt" } }],
    ["a direction override", { ...valid, text: { ar: "نص", en: "Te‮xt" } }],
    ["a note over 300 characters", { ...valid, note: "n".repeat(301) }],
    ["a text over 100,000 characters", { ...valid, text: { ar: "ا".repeat(100_001), en: "Text" } }],
    ["a field it does not know", { ...valid, published: true }],
  ])("refuses %s", (_name, body) => {
    expect(legalPublishSchema.safeParse(body).success).toBe(false);
  });

  it("keeps new lines in a text", () => {
    const parsed = legalPublishSchema.safeParse({ ...valid, text: { ar: "نص\n\nفقرة", en: "A\n\nB" } });
    expect(parsed.success).toBe(true);
  });
});

describe("helpDocSchema", () => {
  it("takes an article in both languages", () => {
    expect(helpDocSchema.safeParse(article).success).toBe(true);
  });

  it("takes an article in one language only", () => {
    const english = {
      ...article,
      question: { ar: "", en: "Prizes?" },
      answer: { ar: "", en: "At the desk." },
    };
    expect(helpDocSchema.safeParse(english).success).toBe(true);
  });

  it.each([
    ["a question without its answer", { ...article, answer: { ar: "", en: "A" } }],
    ["an answer without its question", { ...article, question: { ar: "", en: "Q" } }],
    ["no language at all", { ...article, question: { ar: "", en: "" }, answer: { ar: "", en: "" } }],
    ["English in the Arabic box", { ...article, question: { ar: "Join", en: "Q" } }],
    ["Arabic in the English box", { ...article, question: { ar: "س", en: "سؤال" } }],
    ["an answer over 4,000 characters", { ...article, answer: { ar: "ج", en: "a".repeat(4001) } }],
    ["position zero", { ...article, position: 0 }],
    ["a fractional position", { ...article, position: 1.5 }],
  ])("refuses %s", (_name, body) => {
    expect(helpDocSchema.safeParse(body).success).toBe(false);
  });
});

describe("shownHelp", () => {
  const both = { id: "join", question: article.question, answer: article.answer };
  const englishOnly = {
    id: "prizes",
    question: { ar: "", en: "Prizes?" },
    answer: { ar: "", en: "At the desk." },
  };

  it("shows the reader's language when the article has it", () => {
    expect(shownHelp(both, "ar")).toEqual({
      id: "join",
      question: "كيف أنضم؟",
      answer: "امسح الرمز.",
      language: "ar",
    });
  });

  it("shows the other language when the reader's is missing", () => {
    expect(shownHelp(englishOnly, "ar")).toEqual({
      id: "prizes",
      question: "Prizes?",
      answer: "At the desk.",
      language: "en",
    });
  });
});
