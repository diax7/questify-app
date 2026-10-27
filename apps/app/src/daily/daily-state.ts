import type {
  DailyAnswerReply,
  DailyChallenge,
  DailyGuessReply,
  DailyLanguage,
  DailyWordGame,
} from "@questify/shared";

/** A word game is six tries (FR-1810). */
export const MAX_ATTEMPTS = 6;

type Question = DailyChallenge["questions"][number];
type Play = NonNullable<DailyWordGame["play"]>;

/** The question to show next: the first one not answered yet, in order; undefined once all three are. */
export function nextQuestion(challenge: DailyChallenge): Question | undefined {
  return [...challenge.questions]
    .sort((a, b) => a.position - b.position)
    .find((question) => question.answered === null);
}

/** How many questions are answered so far. */
export const answeredCount = (challenge: DailyChallenge): number =>
  challenge.questions.filter((question) => question.answered !== null).length;

/** The challenge with one answer written in, and the finish when that answer was the last. */
export function withAnswer(challenge: DailyChallenge, reply: DailyAnswerReply): DailyChallenge {
  const { position, choice, correct, right } = reply.answer;
  return {
    ...challenge,
    questions: challenge.questions.map((question) =>
      question.position === position
        ? { ...question, answered: { choice, correct, right } }
        : question,
    ),
    finished: reply.finished ?? challenge.finished,
  };
}

/**
 * The language of the player's game: the one already played (one word game a period, whatever the language), else the
 * app's language when it has a word, else the one that has a word; null when no language has a word.
 */
export function wordLanguage(game: DailyWordGame, preferred: DailyLanguage): DailyLanguage | null {
  if (game.play !== null) return game.play.language;
  if (game.languages.includes(preferred)) return preferred;
  return game.languages[0] ?? null;
}

/** The id of the word to guess in this language: the played one, else the period's word in that language. */
export function wordIdFor(game: DailyWordGame, language: DailyLanguage): number | null {
  if (game.play !== null) return game.play.language === language ? game.play.wordId : null;
  return game.words.find((word) => word.language === language)?.id ?? null;
}

/** The attempt the next guess is (1 to 6). */
export const nextAttempt = (game: DailyWordGame): number => (game.play?.guesses.length ?? 0) + 1;

/**
 * The game with one guess written in. A reply for an attempt already held replaces it (a retried move returns the
 * stored one) and drops any later attempt; the finish arrives with the last guess.
 */
export function withGuess(
  game: DailyWordGame,
  chosen: Readonly<{ language: DailyLanguage; wordId: number }>,
  reply: DailyGuessReply,
): DailyWordGame {
  const play: Play = game.play ?? {
    language: chosen.language,
    wordId: chosen.wordId,
    guesses: [],
    finished: null,
  };
  const kept = play.guesses.slice(0, Math.max(0, reply.guess.attempt - 1));
  const guesses = [...kept, { guess: reply.guess.guess, marks: reply.guess.marks }];
  return { ...game, play: { ...play, guesses, finished: reply.finished ?? play.finished } };
}

/** 0 absent, 1 elsewhere, 2 right place. */
export type Mark = 0 | 1 | 2;

const MARK_OF: Readonly<Record<string, Mark>> = { "0": 0, "1": 1, "2": 2 };

/** The marks of one guess as numbers, one per letter. */
export const marksOf = (marks: string): Mark[] => [...marks].map((mark) => MARK_OF[mark] ?? 0);

/** The best mark each letter has earned across the guesses, for the keyboard (right place beats elsewhere beats absent). */
export function keyMarks(
  guesses: ReadonlyArray<Readonly<{ guess: string; marks: string }>>,
): Map<string, Mark> {
  const best = new Map<string, Mark>();
  for (const { guess, marks } of guesses) {
    const letters = [...guess];
    marksOf(marks).forEach((mark, index) => {
      const letter = letters[index];
      if (letter !== undefined && mark >= (best.get(letter) ?? -1)) best.set(letter, mark);
    });
  }
  return best;
}
