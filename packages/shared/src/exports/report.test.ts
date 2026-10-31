import { describe, expect, it } from "vitest";
import type { SurveyExport } from "#src/exports/exports";
import { REPORT_LIMITS, buildReport, reportSchema } from "#src/exports/report";

const ID = "7d9f3f8e-2b1c-4c43-8f0e-0a2b9f9a1111";
const text = (en: string) => ({ ar: null, en });
const start = {
  name: text("Expo"),
  startsAt: "2026-10-30T08:00:00+00:00",
  endsAt: null,
  zone: "Asia/Riyadh",
  fields: [],
};
const participation = {
  joined: 120,
  active: 90,
  activation: 75,
  returning: 12,
  rehearsal: false,
  unit: "day" as const,
  series: [],
  sources: {
    code: 1,
    qr: 1,
    link: 1,
    public_list: 1,
    invite: 1,
    operator: 1,
    rehearsal: 0,
    other: 0,
  },
};
const reward = (name: string, redeemed: number) => ({
  id: ID,
  name: text(name),
  price: 10,
  redeemed,
  unclaimed: 0,
  stockLeft: 5,
  removed: false,
});
const economy = {
  earned: 5000,
  spent: 1200,
  unclaimed: 3,
  rewards: [reward("Mug", 2), reward("Hoodie", 30), reward("Cap", 9)],
};
const quests = {
  joined: 120,
  categories: [
    {
      id: ID,
      name: text("Hall"),
      inOrder: false,
      quests: ["A", "B", "C", "D", "E", "F", "G"].map((title, index) => ({
        id: ID,
        title: text(title),
        done: 3 + index * 10,
        step: true,
        skipped: false,
      })),
    },
  ],
};
const survey = (total: number, texts: string[] = []): SurveyExport => ({
  quest: text("Feedback"),
  results: {
    total,
    questions: [
      {
        id: "c",
        kind: "choice",
        text: text("Best part?"),
        answered: total,
        choices: [
          { id: "x", text: text("Talks"), count: 3 },
          { id: "y", text: text("Food"), count: total - 3 },
        ],
        average: null,
        texts: null,
      },
      {
        id: "r",
        kind: "rating",
        text: text("Rate it"),
        answered: total,
        choices: null,
        average: total === 0 ? null : 4.25,
        texts: null,
      },
      {
        id: "t",
        kind: "text",
        text: text("Comments"),
        answered: texts.length,
        choices: null,
        average: null,
        texts,
      },
    ],
  },
});
const build = (surveys: SurveyExport[]) =>
  buildReport({
    start,
    participation,
    quests,
    economy,
    surveys,
    generatedAt: "2026-10-31T10:00:00.000Z",
  });

describe("the one-page report", () => {
  it("carries the headline numbers as they are, with the total of redemptions", () => {
    const report = build([]);
    expect(report.headline).toEqual({
      joined: 120,
      active: 90,
      activation: 75,
      returning: 12,
      earned: 5000,
      spent: 1200,
      redeemed: 41,
    });
    expect(reportSchema.safeParse(report).success).toBe(true);
  });

  it("lists the most popular quests and rewards, most first, leaving out a small count and the smallest shown beside it", () => {
    const report = build([]);
    expect(report.quests.map((quest) => quest.title.en)).toEqual(["G", "F", "E", "D", "C"]);
    expect(report.quests).toHaveLength(REPORT_LIMITS.quests);
    expect(report.rewards.map((one) => [one.name.en, one.redeemed])).toEqual([
      ["Hoodie", 30],
      ["Cap", null],
      ["Mug", null],
    ]);
  });

  it("holds no player and quotes no written answer", () => {
    const json = JSON.stringify(build([survey(12, ["call me on 0555", "great"])]));
    expect(json).not.toMatch(/call me|great|0555|username|email/i);
  });

  it("gives choice counts, the rating average and the number of written answers of a survey", () => {
    const report = build([survey(12, ["a", "b", "c", "d", "e", "f"])]);
    const [first] = report.surveys;
    expect(first).toMatchObject({ responses: 12 });
    expect(first?.questions[0]?.choices?.map((choice) => choice.count)).toEqual([null, 9]);
    expect(first?.questions[1]).toMatchObject({ average: 4.25, answered: 12 });
    expect(first?.questions[2]).toMatchObject({ written: 6 });
  });

  it("gives no average for a rating answered by fewer players than the floor", () => {
    const report = build([
      {
        quest: text("Feedback"),
        results: {
          total: 9,
          questions: [
            {
              id: "r",
              kind: "rating",
              text: text("Rate it"),
              answered: 3,
              choices: null,
              average: 5,
              texts: null,
            },
          ],
        },
      },
    ]);
    expect(report.surveys[0]?.questions[0]).toMatchObject({ answered: null, average: null });
  });

  it("gives no result for a survey with fewer responses than the floor, or for one nobody answered", () => {
    const [few, none] = build([survey(4), survey(0)]).surveys;
    expect(few).toMatchObject({ responses: null, questions: [] });
    expect(none).toMatchObject({ responses: 0, questions: [] });
  });

  it("shows three surveys and counts the rest", () => {
    const report = build([survey(9), survey(9), survey(9), survey(9), survey(9)]);
    expect(report.surveys).toHaveLength(3);
    expect(report.moreSurveys).toBe(2);
  });
});
