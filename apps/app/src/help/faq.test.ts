import { describe, expect, it } from "vitest";
import { faqFrom } from "#src/help/faq.ts";

const article = (id: string, question: { ar: string; en: string }, answer: { ar: string; en: string }) => ({
  id,
  question,
  answer,
});

describe("faqFrom", () => {
  const body = {
    articles: [
      article("join", { ar: "كيف أنضم؟", en: "How do I join?" }, { ar: "امسح الرمز.", en: "Scan the code." }),
      article("prizes", { ar: "", en: "Prizes?" }, { ar: "", en: "At the desk." }),
      article("rtl", { ar: "سؤال", en: "" }, { ar: "جواب", en: "" }),
    ],
  };

  it("shows each article in the reader's language", () => {
    expect(faqFrom(body, "ar")?.[0]).toEqual({
      id: "join",
      question: "كيف أنضم؟",
      answer: "امسح الرمز.",
      language: "ar",
    });
    expect(faqFrom(body, "en")?.[0]?.question).toBe("How do I join?");
  });

  it("shows the language that exists when the reader's has none", () => {
    expect(faqFrom(body, "ar")?.[1]).toEqual({
      id: "prizes",
      question: "Prizes?",
      answer: "At the desk.",
      language: "en",
    });
    expect(faqFrom(body, "en")?.[2]).toMatchObject({ question: "سؤال", language: "ar" });
  });

  it("answers nothing for a body that is not a help list", () => {
    expect(faqFrom({ articles: [{ id: "Bad Id" }] }, "en")).toBeUndefined();
    expect(faqFrom(undefined, "en")).toBeUndefined();
    expect(faqFrom({ articles: [] }, "en")).toEqual([]);
  });
});
