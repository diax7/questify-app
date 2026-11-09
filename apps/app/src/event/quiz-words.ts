import type { Language, LocalizedText, MessageKey } from "@questify/shared";
import { bonusLine, itemLine } from "#src/event/amount.ts";
import { firstBonusLine } from "#src/event/first-bonus.ts";
import type { QuizAnswered, QuizStep, QuizView } from "#src/event/plays.ts";
import { textIn } from "#src/i18n/text.ts";
import { levelUpMessage } from "#src/questify/level.ts";
import { streakBonusLine } from "#src/streaks/event-streak.ts";

type Translate = (key: MessageKey, params?: Readonly<Record<string, string | number>>) => string;

/** Right, wrong or closed for one question, with the right answer's words (FR-209, FR-210). */
export function revealText(answered: QuizAnswered, t: Translate, language: Language): string {
  const right = answered.choices.find((choice) => choice.id === answered.rightChoiceId);
  const answer = right === undefined ? "" : textIn(right.text, language);
  if (answered.right) {
    return t("play.quiz.right");
  }
  return answered.closed ? t("play.quiz.closed", { answer }) : t("play.quiz.wrong", { answer });
}

/** A paused quiz takes no new attempt, but an attempt already open goes on to its end (the server allows it). */
export const attemptAllowed = (questState: string, status: QuizView["status"]): boolean =>
  questState === "open" || status === "open";

/** The move the intro's button makes: the first question, or the next one of an attempt already begun. */
export const startAction = (status: QuizView["status"]): "start" | "next" =>
  status === "none" ? "start" : "next";

/** A failed move: the connection (shown in words) or the server's own message (shown as a problem). */
export type QuizProblem = LocalizedText | "network" | null;

/** Splits a problem into the connection line and the message, so the screen shows one of them. */
export const problemView = (
  problem: QuizProblem,
): Readonly<{ network: boolean; message: LocalizedText | null }> => ({
  network: problem === "network",
  message: problem === "network" ? null : problem,
});

/** On the result, the line for the answer that just finished the quiz; null when the screen was only reopened. */
export const finalAnswerLine = (
  step: Pick<QuizStep, "result"> | null,
  view: Pick<QuizView, "answered">,
  t: Translate,
  language: Language,
): string | null =>
  step?.result == null ? null : revealText(view.answered.at(-1) as QuizAnswered, t, language);

/** One line under the result, keyed so the list keeps its place. */
export type ResultLine = Readonly<{ key: string; text: string }>;

type Extras = Pick<QuizStep, "boost" | "item" | "bonus" | "firstBonus" | "streakBonus" | "levelUp">;

const NO_EXTRAS: Extras = {
  boost: null,
  item: null,
  bonus: null,
  firstBonus: null,
  streakBonus: null,
  levelUp: null,
};

type ExtraLine = readonly [
  key: string,
  line: (t: Translate, language: Language, step: Extras) => string | null,
];

/** In the order the result shows them; each is null when the step did not pay it (an older API sends none). */
const EXTRA_LINES: readonly ExtraLine[] = [
  ["boost", (t, _language, step) => (step.boost == null ? null : t("completion.boosted"))],
  ["item", (t, language, step) => (step.item == null ? null : itemLine(t, language, step.item))],
  [
    "bonus",
    (t, language, step) => (step.bonus == null ? null : bonusLine(t, language, step.bonus)),
  ],
  [
    "firstBonus",
    (t, language, step) =>
      step.firstBonus == null ? null : firstBonusLine(t, language, step.firstBonus),
  ],
  [
    "streakBonus",
    (t, _language, step) =>
      step.streakBonus == null ? null : streakBonusLine(t, step.streakBonus),
  ],
  [
    "levelUp",
    (t, language, step) =>
      step.levelUp == null ? null : levelUpMessage(t, language, step.levelUp),
  ],
];

/** What the finishing step paid beyond the points, in order: boost, item, category bonus, first-N, streak, level. */
export function extraResultLines(
  t: Translate,
  language: Language,
  step: Extras | null,
): readonly ResultLine[] {
  return EXTRA_LINES.flatMap(([key, line]) => {
    const text = line(t, language, step ?? NO_EXTRAS);
    return text === null ? [] : [{ key, text }];
  });
}
