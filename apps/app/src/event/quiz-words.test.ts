import type { MessageKey } from "@questify/shared";
import { describe, expect, it } from "vitest";
import type { QuizAnswered, QuizView } from "#src/event/plays.ts";
import {
  attemptAllowed,
  extraResultLines,
  finalAnswerLine,
  problemView,
  revealText,
  startAction,
} from "#src/event/quiz-words.ts";

/** A translator that shows the key and its parameters, so a test pins which words and which numbers. */
const t = (key: MessageKey, params?: Readonly<Record<string, string | number>>) =>
  params === undefined ? key : `${key} ${JSON.stringify(params)}`;

const answered = (fields: Partial<QuizAnswered> = {}): QuizAnswered => ({
  position: 1,
  id: "q1",
  text: { ar: "سؤال", en: "Question" },
  choices: [
    { id: "a", text: { ar: "أ", en: "A" } },
    { id: "b", text: { ar: "ب", en: "B" } },
  ],
  choiceId: "a",
  rightChoiceId: "b",
  right: false,
  closed: false,
  ...fields,
});

describe("right, wrong or closed", () => {
  it.each<[Partial<QuizAnswered>, "ar" | "en", string]>([
    [{ right: true }, "en", "play.quiz.right"],
    [{ right: true, closed: true }, "ar", "play.quiz.right"],
    [{ right: false, closed: false }, "en", 'play.quiz.wrong {"answer":"B"}'],
    [{ right: false, closed: false }, "ar", 'play.quiz.wrong {"answer":"ب"}'],
    [{ right: false, closed: true, choiceId: null }, "en", 'play.quiz.closed {"answer":"B"}'],
    [{ right: false, closed: true, choiceId: null }, "ar", 'play.quiz.closed {"answer":"ب"}'],
    [{ rightChoiceId: "zzz" }, "en", 'play.quiz.wrong {"answer":""}'],
    [{ rightChoiceId: "zzz", closed: true }, "en", 'play.quiz.closed {"answer":""}'],
    [{ rightChoiceId: "zzz", right: true }, "en", "play.quiz.right"],
  ])("%o in %s says %s", (fields, language, expected) => {
    expect(revealText(answered(fields), t, language)).toBe(expected);
  });
});

describe("whether an attempt may go on", () => {
  it.each<[string, QuizView["status"], boolean]>([
    ["open", "none", true],
    ["open", "open", true],
    ["open", "finished", true],
    ["open", "void", true],
    ["paused", "none", false],
    ["paused", "open", true],
    ["paused", "finished", false],
    ["paused", "void", false],
    ["locked", "none", false],
    ["done", "open", true],
  ])("quest %s with a quiz %s gives %s", (state, status, expected) => {
    expect(attemptAllowed(state, status)).toBe(expected);
  });

  it.each<[QuizView["status"], "start" | "next"]>([
    ["none", "start"],
    ["open", "next"],
    ["finished", "next"],
    ["void", "next"],
  ])("the intro's button on a %s quiz makes the move %s", (status, move) => {
    expect(startAction(status)).toBe(move);
  });
});

describe("a failed move", () => {
  it.each([
    [null, { network: false, message: null }],
    ["network", { network: true, message: null }],
    [
      { ar: "م", en: "m" },
      { network: false, message: { ar: "م", en: "m" } },
    ],
  ] as const)("%o is split as %o", (problem, expected) => {
    expect(problemView(problem)).toEqual(expected);
  });
});

describe("the result's lines", () => {
  const last = answered({ right: true });
  const view = { answered: [answered(), last] };

  it.each([
    [null, null],
    [{ result: null }, null],
    [{ result: { right: true, rightChoiceId: "b" } }, "play.quiz.right"],
    [{ result: { right: false, rightChoiceId: "b" } }, "play.quiz.right"],
  ])("the final answer line for step %o is %j", (step, expected) => {
    expect(finalAnswerLine(step, view, t, "en")).toBe(expected);
  });

  it("says the last question's reveal, not the first", () => {
    const wrong = answered({ right: false, closed: true });
    const line = finalAnswerLine(
      { result: { right: false, rightChoiceId: "b" } },
      { answered: [last, wrong] },
      t,
      "en",
    );
    expect(line).toBe('play.quiz.closed {"answer":"B"}');
  });

  const none = {
    boost: null,
    item: null,
    bonus: null,
    firstBonus: null,
    streakBonus: null,
    levelUp: null,
  };
  const item = {
    name: { ar: "قميص", en: "Shirt" },
    outcome: "out_of_stock" as const,
    until: null,
  };
  const paid = {
    boost: { multiplier: 2 },
    item,
    bonus: { points: 50, category: { ar: "مرحلة", en: "Stage" }, item: null },
    firstBonus: { points: 20, place: 1, slots: 3 },
    streakBonus: { points: 25, days: 3 },
    levelUp: { level: 6, title: { ar: "فارس", en: "Knight" } },
  };

  it("shows nothing without a step or when nothing was paid", () => {
    expect(extraResultLines(t, "en", null)).toEqual([]);
    expect(extraResultLines(t, "en", none)).toEqual([]);
  });

  it("shows every line in order", () => {
    expect(extraResultLines(t, "en", paid)).toEqual([
      { key: "boost", text: "completion.boosted" },
      { key: "item", text: 'questsTab.itemOut {"item":"Shirt"}' },
      { key: "bonus", text: 'questsTab.bonusPaid {"points":"50","category":"Stage"}' },
      { key: "firstBonus", text: 'play.firstBonus.won {"slots":"3","points":"20"}' },
      { key: "streakBonus", text: 'streak.bonusPaid {"days":3,"points":25}' },
      { key: "levelUp", text: 'level.upLine {"level":6,"title":"Knight"}' },
    ]);
  });

  it.each(["boost", "item", "bonus", "firstBonus", "streakBonus", "levelUp"] as const)(
    "shows only %s when only it was paid",
    (field) => {
      const lines = extraResultLines(t, "en", { ...none, [field]: paid[field] });
      expect(lines.map((line) => line.key)).toEqual([field]);
    },
  );

  it("says a missed first bonus, a points-less bonus and a pending item in words", () => {
    expect(
      extraResultLines(t, "ar", {
        ...none,
        firstBonus: { points: 0, place: null, slots: 3 },
        bonus: { points: 0, category: { ar: "مرحلة", en: "Stage" }, item: null },
      }),
    ).toEqual([
      { key: "bonus", text: 'questsTab.categoryDone {"category":"مرحلة"}' },
      { key: "firstBonus", text: 'play.firstBonus.missed {"slots":"3"}' },
    ]);
  });
});
