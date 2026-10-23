import {
  GAME_LEVEL_KEYS,
  formatEventTime,
  formatNumber,
  targetWords,
  type EventTerms,
  type Language,
  type MessageKey,
} from "@questify/shared";
import { paidText } from "#src/event/amount.ts";
import type { GameSheet, ResultAnswer, SheetAction } from "#src/event/games.ts";

type Translate = (key: MessageKey, params?: Readonly<Record<string, string | number>>) => string;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
const count = (value: unknown): number => (typeof value === "number" ? value : 0);

/** The level in words: "Level: Medium"; one this build does not know shows as sent. */
export function levelLine(t: Translate, level: string): string {
  const key = Object.hasOwn(GAME_LEVEL_KEYS, level)
    ? GAME_LEVEL_KEYS[level as keyof typeof GAME_LEVEL_KEYS]
    : undefined;
  return t("play.game.level", { level: key === undefined ? level : t(key) });
}

/** The attempts in words: "2 of 3 attempts left", or "Unlimited attempts". */
export function attemptsLine(t: Translate, sheet: GameSheet, language: Language): string {
  return sheet.attempts === null || sheet.attemptsLeft === null
    ? t("play.game.unlimited")
    : t("play.game.attemptsLeft", {
        left: formatNumber(sheet.attemptsLeft, language),
        total: formatNumber(sheet.attempts, language),
      });
}

/** Why the sheet offers no Play (FR-1807): passed, already played, no attempts left, or the next try's time. */
export function actionLine(
  t: Translate,
  action: SheetAction,
  language: Language,
  timeZone: string,
): string | null {
  switch (action.kind) {
    case "passed":
      return t("play.game.passed");
    case "already_played":
      return t("play.game.alreadyPlayed");
    case "no_attempts":
      return t("play.game.noAttempts");
    case "cooldown":
      return t("play.game.cooldown", {
        time: formatEventTime(new Date(action.retryAt), timeZone, language),
      });
    default:
      return null;
  }
}

/** A short round's result beside its target (FR-217): what was found or moved, then what the level asks. */
function shortLines(
  t: Translate,
  answer: Extract<ResultAnswer, { kind: "short" }>,
  language: Language,
): string {
  const result = isRecord(answer.result) ? answer.result : {};
  const said =
    answer.target.game === "memory_match"
      ? t("play.game.shortMemory", {
          pairs: formatNumber(count(result["pairs"]), language),
          total: formatNumber(answer.target.pairs, language),
          moves: formatNumber(count(result["moves"]), language),
        })
      : t("play.game.shortSlide", { moves: formatNumber(count(result["moves"]), language) });
  return `${said} ${t("play.game.goal", { target: targetWords(t, answer.target, language) })}`;
}

/** A result's answer in words: paid, already complete, short, not counted, or counted as played; null to retry. */
export function resultLine(
  t: Translate,
  answer: ResultAnswer,
  terms: EventTerms,
  language: Language,
): string {
  switch (answer.kind) {
    case "passed": {
      const paid = paidText(t, terms, language, answer);
      return answer.levelUp === null
        ? paid
        : `${paid} ${t("level.upLine", { level: answer.levelUp.level, title: answer.levelUp.title[language] })}`;
    }
    case "done":
      return t("play.game.done");
    case "short":
      return shortLines(t, answer, language);
    case "refused":
      return t("play.game.refused");
    case "expired":
      return t("play.game.expired");
    default:
      return t("play.game.unsent");
  }
}

/** Whether an answer leaves the result to send again (a lost answer, a busy server). */
export const resendable = (answer: ResultAnswer): boolean =>
  answer.kind === "network" || answer.kind === "failed";
