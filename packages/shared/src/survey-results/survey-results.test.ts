import { describe, expect, it } from "vitest";
import {
  QUEST_THUMBS,
  SURVEY_SHARE_TOKEN,
  memberQuestRatingSchema,
  questRatingBodySchema,
  questScorePercent,
  sharedSurveyResultsSchema,
  surveyResultsCsv,
  surveyResultsOpenBodySchema,
  withoutContactDetails,
  type SharedSurveyResults,
  type SurveyCsvLabels,
} from "./survey-results";

const LABELS: SurveyCsvLabels = {
  question: "Question",
  kind: "Type",
  answer: "Answer",
  count: "Count",
  choice: "Choice",
  rating: "Rating",
  text: "Text",
  average: "Average",
  responses: "Responses",
  noAnswers: "No answers were received.",
};
const text = (en: string | null, ar: string | null = null) => ({ ar, en });
const BOM = "﻿";

const results = (over: Partial<SharedSurveyResults> = {}): SharedSurveyResults => ({
  quest: text("Talk"),
  event: text("Fest"),
  total: 3,
  questions: [
    {
      id: "fav",
      kind: "choice",
      text: text("Favourite?", "المفضل؟"),
      answered: 3,
      choices: [
        { id: "ai", text: text("AI"), count: 2 },
        { id: "web", text: text("Web", "ويب"), count: 1 },
      ],
      average: null,
      texts: null,
    },
    {
      id: "stars",
      kind: "rating",
      text: text("Stars"),
      answered: 3,
      choices: null,
      average: 4.25,
      texts: null,
    },
    {
      id: "note",
      kind: "text",
      text: text("Note"),
      answered: 4,
      choices: null,
      average: null,
      texts: ["Great talk", "Call 0501234567", "mail me@example.com", "=SUM(A1)"],
    },
  ],
  ...over,
});

const lines = (csv: string): string[] => csv.replace(BOM, "").trimEnd().split("\r\n");

describe("the survey spreadsheet (FR-1624)", () => {
  it("lists the response count, each choice's count, the rating average and each text answer", () => {
    expect(lines(surveyResultsCsv(results(), "en", LABELS))).toEqual([
      "Question,Type,Answer,Count",
      "Responses,,,3",
      "Favourite?,Choice,AI,2",
      "Favourite?,Choice,Web,1",
      "Stars,Rating,Average,4.25",
      "Note,Text,Great talk,",
      "Note,Text,Call 0501234567,",
      "Note,Text,mail me@example.com,",
      "Note,Text,'=SUM(A1),",
    ]);
  });

  it("starts with a byte-order mark so Excel reads Arabic, and uses Arabic text where it has it", () => {
    const csv = surveyResultsCsv(results(), "ar", LABELS);
    expect(csv.startsWith(BOM)).toBe(true);
    expect(lines(csv)[2]).toBe("المفضل؟,Choice,AI,2");
    expect(lines(csv)[3]).toBe("المفضل؟,Choice,ويب,1");
  });

  it("says no answers were received for a survey nobody answered", () => {
    expect(lines(surveyResultsCsv(results({ total: 0 }), "en", LABELS))).toEqual([
      "Question,Type,Answer,Count",
      "No answers were received.,,,0",
    ]);
  });

  it("marks an unanswered rating and text question, and quotes what holds a comma", () => {
    const rows = lines(
      surveyResultsCsv(
        results({
          questions: [
            {
              id: "s",
              kind: "rating",
              text: text("Stars, please"),
              answered: 0,
              choices: null,
              average: null,
              texts: null,
            },
            {
              id: "n",
              kind: "text",
              text: text("Note"),
              answered: 0,
              choices: null,
              average: null,
              texts: [],
            },
            {
              id: "m",
              kind: "text",
              text: text("More"),
              answered: 1,
              choices: null,
              average: null,
              texts: ["a, b"],
            },
          ],
        }),
        "en",
        LABELS,
      ),
    );
    expect(rows.slice(2)).toEqual([
      '"Stars, please",Rating,No answers were received.,',
      "Note,Text,No answers were received.,0",
      'More,Text,"a, b",',
    ]);
  });

  it("uses Western digits whatever the language", () => {
    expect(surveyResultsCsv(results(), "ar", LABELS)).not.toMatch(/[٠-٩]/u);
  });
});

describe("what a speaker may read", () => {
  it("leaves out text answers that look like an address or a phone number, and counts them", () => {
    const shown = withoutContactDetails(results());
    const note = shown.questions[2];
    expect(note?.texts).toEqual(["Great talk", "=SUM(A1)"]);
    expect(note?.hiddenTexts).toBe(2);
    expect(shown.questions[0]?.hiddenTexts).toBe(0);
    expect(shown.total).toBe(3);
  });

  it("shows no text answer while fewer than three players answered, and counts them", () => {
    const shown = withoutContactDetails(results({ total: 2 }));
    expect(shown.questions[2]?.texts).toEqual([]);
    expect(shown.questions[2]?.hiddenTexts).toBe(4);
    expect(shown.questions[0]?.choices).toEqual(results().questions[0]?.choices);
  });

  it("leaves out hidden characters and a phone number spaced out or in Arabic digits", () => {
    const shown = withoutContactDetails(
      results({
        questions: [
          {
            id: "n",
            kind: "text",
            text: text("Note"),
            answered: 4,
            choices: null,
            average: null,
            texts: ["zero​width", "0 5 0 1 2 3 4 5 6 7", "٠٥٠١٢٣٤٥٦٧", "fine"],
          },
        ],
      }),
    );
    expect(shown.questions[0]?.texts).toEqual(["fine"]);
    expect(shown.questions[0]?.hiddenTexts).toBe(3);
  });
});

describe("the schemas", () => {
  it("accepts a thumb up, down or skip and nothing else", () => {
    for (const thumb of QUEST_THUMBS) {
      expect(questRatingBodySchema.safeParse({ thumb }).success).toBe(true);
    }
    for (const bad of [{ thumb: "left" }, {}, { thumb: "up", extra: true }, { thumb: null }]) {
      expect(questRatingBodySchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    expect(memberQuestRatingSchema.safeParse({ on: true, thumb: null }).success).toBe(true);
    expect(memberQuestRatingSchema.safeParse({ on: true, thumb: "up", eventId: "x" }).success).toBe(
      false,
    );
  });

  it("scores a quest as the whole percent of thumbs up, and nothing for a quest with no thumb", () => {
    expect(questScorePercent({ up: 0, down: 0 })).toBeNull();
    expect(questScorePercent({ up: 1, down: 0 })).toBe(100);
    expect(questScorePercent({ up: 0, down: 4 })).toBe(0);
    expect(questScorePercent({ up: 2, down: 1 })).toBe(67);
    expect(questScorePercent({ up: 1, down: 2 })).toBe(33);
  });

  it("takes a link token of 43 URL-safe characters", () => {
    const good = "A".repeat(43);
    expect(SURVEY_SHARE_TOKEN.test(good)).toBe(true);
    expect(surveyResultsOpenBodySchema.safeParse({ token: good }).success).toBe(true);
    for (const bad of [
      "",
      "A".repeat(42),
      "A".repeat(44),
      `${"A".repeat(42)}+`,
      `${"A".repeat(42)} `,
    ]) {
      expect(surveyResultsOpenBodySchema.safeParse({ token: bad }).success, bad).toBe(false);
    }
    expect(surveyResultsOpenBodySchema.safeParse({ token: good, more: 1 }).success).toBe(false);
  });

  it("reads the database's answer, filling a missing language with null", () => {
    const parsed = sharedSurveyResultsSchema.parse({
      quest: { en: "Talk" },
      event: { ar: "فعالية" },
      total: 0,
      questions: [],
    });
    expect(parsed.quest).toEqual({ ar: null, en: "Talk" });
    expect(parsed.event).toEqual({ ar: "فعالية", en: null });
  });
});
