import type { DailyConflictReason, DailyGuessRefusal, MessageKey } from "@questify/shared";
import type { MoveOutcome } from "#src/daily/daily-api.ts";

/** What a screen does with the answer to a move (an answer or a guess). */
export type MoveStep = Readonly<{
  /** The reply is written into the game. */
  apply: boolean;
  /** The line to show, or null for none. */
  notice: MessageKey | null;
  /** The games are read again, so the screen shows what the server holds. */
  reread: boolean;
  /** The player is signed out: leave for the start screen. */
  leave: boolean;
}>;

const STEP: MoveStep = { apply: false, notice: null, reread: false, leave: false };

const CONFLICT_NOTICE: Readonly<Record<DailyConflictReason, MessageKey | null>> = {
  period_over: "daily.periodOver",
  changed: "daily.changed",
  other_language: "daily.otherLanguage",
  // The game moved on without this screen (another phone, a retry): reading it again is the whole answer.
  out_of_order: null,
  answered: null,
  attempt_taken: null,
  finished: null,
};

/** The line for a guess the server refused; no try was used, so the typed letters stay. */
const REFUSAL_NOTICE: Readonly<Record<DailyGuessRefusal, MessageKey>> = {
  length: "daily.word.refusedLength",
  letters: "daily.word.refusedLetters",
  not_a_word: "daily.word.refusedNotAWord",
};

type Fixed = Exclude<MoveOutcome<unknown>["kind"], "ok" | "conflict" | "refused" | "network">;

/** Which game a move belongs to: a lost connection says what is kept (the answer, or the typed letters). */
export type DailyGame = "challenge" | "word";
const NETWORK_NOTICE: Readonly<Record<DailyGame, MessageKey>> = {
  challenge: "daily.challenge.networkFailed",
  word: "daily.word.networkFailed",
};

/** Answers whose step does not depend on anything in them. */
const FIXED: Readonly<Record<Fixed, MoveStep>> = {
  unavailable: { ...STEP, notice: "daily.unavailable", reread: true },
  limited: { ...STEP, notice: "daily.limited" },
  // A reply the app cannot read may still have been stored: read again.
  failed: { ...STEP, notice: "error.generic", reread: true },
  signed_out: { ...STEP, leave: true },
};

/**
 * Turns the answer to a move into screen changes. A conflict reads the games again; a refused guess changes nothing but
 * the line; a lost or odd answer reads again too, because the move may have been stored (it is safe to send again).
 */
export function stepAfterMove(outcome: MoveOutcome<unknown>, game: DailyGame): MoveStep {
  switch (outcome.kind) {
    case "ok":
      return { ...STEP, apply: true };
    case "conflict":
      return { ...STEP, notice: CONFLICT_NOTICE[outcome.reason], reread: true };
    case "refused":
      return { ...STEP, notice: REFUSAL_NOTICE[outcome.reason] };
    case "network":
      return { ...STEP, notice: NETWORK_NOTICE[game] };
    default:
      return FIXED[outcome.kind];
  }
}
