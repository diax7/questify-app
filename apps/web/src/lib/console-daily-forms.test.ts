import type { AdminDailyQuestion } from "@questify/shared";
import { describe, expect, it } from "vitest";
import {
  BLANK_CHALLENGE,
  BLANK_QUESTION,
  canPick,
  challengeBodyOf,
  chunkWords,
  parseWordLines,
  questionBodyOf,
  questionDraftOf,
  shownRefusals,
  wordBodyOf,
  type QuestionDraft,
} from "#src/lib/console-daily-forms.ts";

const IDS = [
  "6f1c7a0e-0000-4000-8000-000000000001",
  "6f1c7a0e-0000-4000-8000-000000000002",
  "6f1c7a0e-0000-4000-8000-000000000003",
] as const;

const draft: QuestionDraft = {
  promptAr: "ما عاصمة السعودية؟",
  promptEn: "What is the capital of Saudi Arabia?",
  options: [
    { ar: "الرياض", en: "Riyadh" },
    { ar: "جدة", en: "Jeddah" },
  ],
  answer: "1",
};

describe("questionBodyOf", () => {
  it("sends the right option as a number", () => {
    const checked = questionBodyOf({ ...draft, answer: "2" });
    expect(checked.ok && checked.body.answer).toBe(2);
  });

  it("trims what was typed", () => {
    const checked = questionBodyOf({ ...draft, promptEn: "  Capital?  " });
    expect(checked.ok && checked.body.prompt.en).toBe("Capital?");
  });

  it.each([
    ["no Arabic prompt", { promptAr: " " }, "prompt"],
    ["a prompt past 300 characters", { promptEn: "x".repeat(301) }, "prompt"],
    ["a direction-override character", { promptEn: "What‮?" }, "prompt"],
    ["a blank option", { options: [draft.options[0]!, { ar: "", en: "" }] }, "options"],
    ["a single option", { options: [draft.options[0]!] }, "options"],
    ["five options", { options: Array.from({ length: 5 }, () => draft.options[0]!) }, "options"],
    ["no right option chosen", { answer: "" }, "answer"],
    ["a right option past the written ones", { answer: "3" }, "answer"],
  ] as const)("refuses %s before sending", (_name, patch, field) => {
    expect(questionBodyOf({ ...draft, ...patch })).toEqual({ ok: false, field });
  });

  it("starts a new question empty, so it cannot be sent as is", () => {
    expect(questionBodyOf(BLANK_QUESTION).ok).toBe(false);
  });
});

const question = (patch: Partial<AdminDailyQuestion>): AdminDailyQuestion => ({
  id: IDS[0],
  prompt: { ar: "سؤال", en: "Question" },
  options: [
    { ar: "أ", en: "A" },
    { ar: "ب", en: "B" },
  ],
  answer: 2,
  status: "ready",
  scheduledOn: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  ...patch,
});

describe("questionDraftOf and canPick", () => {
  it("opens a saved question as the form holds it", () => {
    expect(questionDraftOf(question({}))).toMatchObject({ promptEn: "Question", answer: "2" });
    expect(questionBodyOf(questionDraftOf(question({}))).ok).toBe(true);
  });

  it("offers a ready question that is free, or already in the challenge being edited", () => {
    expect(canPick(question({}), "2026-11-01")).toBe(true);
    expect(canPick(question({ scheduledOn: "2026-11-01" }), "2026-11-01")).toBe(true);
    expect(canPick(question({ scheduledOn: "2026-11-08" }), "2026-11-01")).toBe(false);
    expect(canPick(question({ status: "retired" }), "2026-11-01")).toBe(false);
  });
});

describe("challengeBodyOf", () => {
  const ready = { ...BLANK_CHALLENGE, questionIds: IDS };

  it("sends three questions and no sponsor when both names are empty", () => {
    expect(challengeBodyOf(ready)).toEqual({
      ok: true,
      body: { questionIds: [...IDS], sponsor: null },
    });
  });

  it("sends a sponsor named in both languages, trimmed", () => {
    const checked = challengeBodyOf({
      ...ready,
      sponsorAr: " شركة النخيل ",
      sponsorEn: " Palm Co ",
    });
    expect(checked.ok && checked.body.sponsor).toEqual({
      name: { ar: "شركة النخيل", en: "Palm Co" },
    });
  });

  it.each([
    ["a question not chosen", { questionIds: [IDS[0], IDS[1], ""] as const }, "questions"],
    ["the same question twice", { questionIds: [IDS[0], IDS[0], IDS[1]] as const }, "questions"],
    ["a sponsor in one language only", { sponsorEn: "Palm Co" }, "sponsor"],
    [
      "a sponsor name past 60 characters",
      { sponsorAr: "ا".repeat(61), sponsorEn: "Palm" },
      "sponsor",
    ],
  ] as const)("refuses %s", (_name, patch, field) => {
    expect(challengeBodyOf({ ...ready, ...patch })).toEqual({ ok: false, field });
  });
});

describe("wordBodyOf", () => {
  it.each([
    ["en", "crane"],
    ["en", " Crane "],
    ["ar", "مدرسة"],
    ["ar", "أَحمدا"],
  ] as const)("accepts %s %j", (language, text) => {
    expect(wordBodyOf(language, text)).toEqual({ ok: true, body: { word: text.trim() } });
  });

  it.each([
    ["en", "cran"],
    ["en", "cranes"],
    ["en", "cr4ne"],
    ["ar", "مدرس"],
    ["ar", "crane"],
  ] as const)("refuses %s %j", (language, text) => {
    expect(wordBodyOf(language, text)).toEqual({ ok: false, field: "word" });
  });
});

describe("parseWordLines", () => {
  it("takes one word a line, trimmed, with blank lines and repeats dropped", () => {
    expect(parseWordLines("crane\r\n  slate \n\n\ncrane\rirate")).toEqual({
      words: ["crane", "slate", "irate"],
      tooLong: 0,
    });
  });

  it("holds back a line past 40 characters and counts it", () => {
    const long = "a".repeat(41);
    expect(parseWordLines(`crane\n${long}\n${"b".repeat(40)}`)).toEqual({
      words: ["crane", "b".repeat(40)],
      tooLong: 1,
    });
  });

  it("counts letters, not bytes, so an Arabic line of 40 letters is kept", () => {
    expect(parseWordLines("ا".repeat(40)).words).toHaveLength(1);
  });

  it("is empty for an empty paste", () => {
    expect(parseWordLines("  \n \n")).toEqual({ words: [], tooLong: 0 });
  });
});

const words = (count: number) => Array.from({ length: count }, (_, index) => `w${String(index)}`);

describe("chunkWords", () => {
  it.each([
    [0, []],
    [1, [1]],
    [20_000, [20_000]],
    [20_001, [20_000, 1]],
    [45_000, [20_000, 20_000, 5_000]],
  ])("splits %i words into calls of at most 20,000", (count, sizes) => {
    expect(chunkWords(words(count)).map((call) => call.length)).toEqual(sizes);
  });

  it("keeps every word once and in order", () => {
    expect(chunkWords(words(20_003)).flat()).toEqual(words(20_003));
  });
});

describe("shownRefusals", () => {
  it("shows at most the first 50", () => {
    const refused = Array.from({ length: 75 }, (_, index) => `x${String(index)}`);
    expect(shownRefusals(refused)).toEqual(refused.slice(0, 50));
  });
});
