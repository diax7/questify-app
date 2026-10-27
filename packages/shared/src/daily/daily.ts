import { z } from "zod";
import { DAILY_LANGUAGES, WORD_LENGTH } from "#src/daily/letters";
import { levelUpSchema } from "#src/questify/quests";
import { dailyStreakSchema } from "#src/streaks/streaks";

/**
 * The daily challenge and the daily word (T-406, ADR-306 to ADR-312): three questions a period, a five-letter word a
 * period per language, XP only, the same content for everyone, nothing sold and nothing left to chance. A period is a
 * Questify day (04:00 to 04:00 Riyadh) or a Sunday-to-Saturday week, per kind.
 */

export const DAILY_KINDS = ["challenge", "word"] as const;
export type DailyKind = (typeof DAILY_KINDS)[number];
export const DAILY_CADENCES = ["daily", "weekly"] as const;
export type DailyCadence = (typeof DAILY_CADENCES)[number];

const day = z.iso.date();
const count = z.number().int().nonnegative();
const bilingual = z.object({ ar: z.string(), en: z.string() });
const language = z.enum(DAILY_LANGUAGES);
const period = z.object({ startsOn: day, endsOn: day });
/** Marks of one guess, one per letter: 2 right place, 1 elsewhere, 0 absent. */
export const marksSchema = z.string().regex(/^[012]{5}$/);

// Texts every player sees: no control, line-separator or bidi embedding, override or isolate character.
const FORBIDDEN = /[\p{Cc}\u2028\u2029\u202A-\u202E\u2066-\u2069]/u;
const text = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !FORBIDDEN.test(value), "must hold no control or direction characters");
const texts = (max: number) => z.strictObject({ ar: text(max), en: text(max) });

// ================================================================ the player's doors

/** `POST /v1/me/daily/challenge/answers`: the question shown at that position and the option chosen. */
export const dailyAnswerBodySchema = z.strictObject({
  challengeId: z.number().int().positive(),
  questionId: z.uuid(),
  position: z.number().int().min(1).max(3),
  choice: z.number().int().min(1).max(4),
});
export type DailyAnswerBody = z.infer<typeof dailyAnswerBodySchema>;

/** `POST /v1/me/daily/word/guesses`: the word shown, the attempt (1 to 6) and the guess as typed. */
export const dailyGuessBodySchema = z.strictObject({
  wordId: z.number().int().positive(),
  attempt: z.number().int().min(1).max(6),
  guess: z.string().min(1).max(40),
});
export type DailyGuessBody = z.infer<typeof dailyGuessBodySchema>;

/** Why a 409 `daily_conflict` refused an answer. */
export const DAILY_ANSWER_CONFLICTS = [
  "period_over",
  "changed",
  "out_of_order",
  "answered",
] as const;
/** Why a 409 `daily_conflict` refused a guess. */
export const DAILY_GUESS_CONFLICTS = [
  "period_over",
  "changed",
  "out_of_order",
  "attempt_taken",
  "finished",
  "other_language",
] as const;
export type DailyConflictReason =
  | (typeof DAILY_ANSWER_CONFLICTS)[number]
  | (typeof DAILY_GUESS_CONFLICTS)[number];
export const dailyConflictSchema = z.object({
  reason: z.enum([...DAILY_ANSWER_CONFLICTS, ...DAILY_GUESS_CONFLICTS]),
});
/** Why a 422 `invalid_guess` refused a guess (no attempt is used). */
export const DAILY_GUESS_REFUSALS = ["length", "letters", "not_a_word"] as const;
export type DailyGuessRefusal = (typeof DAILY_GUESS_REFUSALS)[number];
export const invalidGuessSchema = z.object({ reason: z.enum(DAILY_GUESS_REFUSALS) });
/** The field a 422 `invalid_answer` names. */
export const invalidAnswerSchema = z.object({ field: z.enum(["position", "choice"]) });

const answered = z.object({
  choice: z.number().int().min(1).max(4),
  correct: z.boolean(),
  right: z.number().int().min(1).max(4),
});
const challengeFinish = z.object({ correct: z.number().int().min(0).max(3), xp: count });
const wordFinish = z.object({
  solved: z.boolean(),
  attempts: z.number().int().min(1).max(6),
  xp: count,
  /** The word as written (hamza kept), sent only once the game is over. */
  word: z.string(),
});

/** The current period's challenge; the right option of a question only once it is answered. */
export const dailyChallengeSchema = z.object({
  id: z.number().int().positive(),
  period,
  /** "Presented by {name}" / "برعاية {name}" (ADR-311); null when unsponsored. */
  sponsor: bilingual.nullable(),
  questions: z.array(
    z.object({
      id: z.uuid(),
      position: z.number().int().min(1).max(3),
      prompt: bilingual,
      options: z.array(bilingual).min(2).max(4),
      answered: answered.nullable(),
    }),
  ),
  finished: challengeFinish.nullable(),
});
export type DailyChallenge = z.infer<typeof dailyChallengeSchema>;

/** The current period's word game: the languages with a word and their ids, and the caller's play. */
export const dailyWordGameSchema = z.object({
  period,
  length: z.literal(WORD_LENGTH),
  languages: z.array(language),
  words: z.array(z.object({ language, id: z.number().int().positive() })),
  play: z
    .object({
      language,
      wordId: z.number().int().positive(),
      guesses: z.array(z.object({ guess: z.string(), marks: marksSchema })),
      finished: wordFinish.nullable(),
    })
    .nullable(),
});
export type DailyWordGame = z.infer<typeof dailyWordGameSchema>;

/** `GET /v1/me/daily`: each game null while its switch is off or its period has no content. */
export const ownDailySchema = z.object({
  challenge: dailyChallengeSchema.nullable(),
  word: dailyWordGameSchema.nullable(),
});
export type OwnDaily = z.infer<typeof ownDailySchema>;

/** A level reached by this move (null on a replay: it was shown the first time), the daily streak, and whether the move
 * replayed a stored one. */
const reward = {
  levelUp: levelUpSchema.nullable(),
  dailyStreak: dailyStreakSchema.nullable(),
  replayed: z.boolean(),
};
/** An answer's reply: the answer with the right option, the finish (third answer), a level reached, the streak. */
export const dailyAnswerReplySchema = z.object({
  answer: z.object({ position: z.number().int().min(1).max(3), ...answered.shape }),
  finished: challengeFinish.nullable(),
  ...reward,
});
export type DailyAnswerReply = z.infer<typeof dailyAnswerReplySchema>;
/** A guess's reply: the normalized guess and its marks, the finish (the word only then), a level reached, the streak. */
export const dailyGuessReplySchema = z.object({
  guess: z.object({
    attempt: z.number().int().min(1).max(6),
    guess: z.string(),
    marks: marksSchema,
  }),
  finished: wordFinish.nullable(),
  ...reward,
});
export type DailyGuessReply = z.infer<typeof dailyGuessReplySchema>;

// ================================================================ the console

/** A question as the console writes it: both languages, 2 to 4 options, the right one by its 1-based place. */
export const dailyQuestionBodySchema = z
  .strictObject({
    prompt: texts(300),
    options: z.array(texts(120)).min(2).max(4),
    answer: z.number().int().min(1).max(4),
  })
  .refine((body) => body.answer <= body.options.length, { path: ["answer"] });
export type DailyQuestionBody = z.infer<typeof dailyQuestionBodySchema>;

/** A period's challenge: three different questions in order and an optional sponsor name in both languages. */
export const dailyChallengeBodySchema = z.strictObject({
  questionIds: z
    .array(z.uuid())
    .length(3)
    .refine((ids) => new Set(ids).size === 3, "three different questions"),
  sponsor: z.strictObject({ name: texts(60) }).nullable(),
});
export type DailyChallengeBody = z.infer<typeof dailyChallengeBodySchema>;

/** A period's word in one language, as written (normalized by the server). */
export const dailyWordBodySchema = z.strictObject({ word: z.string().min(1).max(40) });
export type DailyWordBody = z.infer<typeof dailyWordBodySchema>;

/** At most this many words added and removed per guess list call. */
export const WORD_LIST_MAX = 20000;
export const wordListBodySchema = z.strictObject({
  add: z.array(z.string().max(40)).max(WORD_LIST_MAX).default([]),
  remove: z.array(z.string().max(40)).max(WORD_LIST_MAX).default([]),
});
export type WordListBody = z.infer<typeof wordListBodySchema>;

/** A kind's cadence, from the next Questify day. */
export const dailyCadenceBodySchema = z.strictObject({
  kind: z.enum(DAILY_KINDS),
  cadence: z.enum(DAILY_CADENCES),
});
export type DailyCadenceBody = z.infer<typeof dailyCadenceBodySchema>;

/** Why a 409 `daily_content_conflict` refused a console change; `position` names the question at fault. */
export const DAILY_CONTENT_CONFLICTS = [
  "started",
  "scheduled",
  "used",
  "retired",
  "changed",
] as const;
export type DailyContentConflictReason = (typeof DAILY_CONTENT_CONFLICTS)[number];
export const dailyContentConflictSchema = z.object({
  reason: z.enum(DAILY_CONTENT_CONFLICTS),
  position: z.number().int().min(1).max(3).optional(),
});
/** The field a 422 `invalid_daily` names. */
export const DAILY_CONTENT_FIELDS = [
  "prompt",
  "options",
  "answer",
  "questions",
  "sponsor",
  "day",
  "word",
  "language",
  "add",
  "remove",
  "kind",
  "cadence",
  "range",
  "status",
  "not_period_start",
] as const;
export type DailyContentField = (typeof DAILY_CONTENT_FIELDS)[number];
export const invalidDailySchema = z.object({ field: z.enum(DAILY_CONTENT_FIELDS) });

/** A bank question in the console, with its right answer and the day of the challenge that holds it. */
export const adminDailyQuestionSchema = z.object({
  id: z.uuid(),
  prompt: bilingual,
  options: z.array(bilingual),
  answer: z.number().int().min(1).max(4),
  status: z.enum(["ready", "retired"]),
  scheduledOn: day.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AdminDailyQuestion = z.infer<typeof adminDailyQuestionSchema>;

const cover = z.object({ coveredDays: count, coveredPeriods: count, warn: z.boolean() });
const cadenceState = {
  cadence: z.enum(DAILY_CADENCES),
  next: z.object({ cadence: z.enum(DAILY_CADENCES), from: day }).nullable(),
};
const consoleChallenge = z.object({
  id: z.number().int().positive(),
  startsOn: day,
  questions: z.array(z.uuid()),
  sponsor: bilingual.nullable(),
  finishes: count,
});
const consoleWord = z.object({
  id: z.number().int().positive(),
  language,
  startsOn: day,
  word: z.string(),
  finishes: count,
});

/** `GET /v1/admin/daily?from&to`: the status and warnings, the schedule by period and the unused content. */
export const dailyConsoleSchema = z.object({
  status: z.object({
    challenge: z.object({ ...cadenceState, ...cover.shape }),
    word: z.object({ ...cadenceState, ar: cover, en: cover }),
  }),
  periods: z.array(
    z.object({
      kind: z.enum(DAILY_KINDS),
      startsOn: day,
      endsOn: day,
      challenge: consoleChallenge.nullable().optional(),
      words: z.object({ ar: consoleWord.optional(), en: consoleWord.optional() }).optional(),
    }),
  ),
  unused: z.array(
    z.object({ kind: z.enum(DAILY_KINDS), language: language.nullable(), startsOn: day }),
  ),
});
export type DailyConsole = z.infer<typeof dailyConsoleSchema>;

/** `GET /v1/admin/daily/questions`: one page of the bank, newest first. */
export const adminDailyQuestionsSchema = z.object({ questions: z.array(adminDailyQuestionSchema) });

/** `GET /v1/admin/daily/word-list/{language}`: up to 100 words of one page and how many words match. */
export const wordListPageSchema = z.object({ words: z.array(z.string()), total: count });
export type WordListPage = z.infer<typeof wordListPageSchema>;

/** `POST /v1/admin/daily/word-list/{language}`: what the change did; `refused` holds the first 50 invalid inputs. */
export const wordListChangeSchema = z.object({
  added: count,
  removed: count,
  refused: z.array(z.string()),
  total: count,
});
export type WordListChange = z.infer<typeof wordListChangeSchema>;

/** `PUT /v1/admin/daily/cadence`: the day it applies from, or `unchanged`; how much content sits on non-start days. */
export const dailyCadenceChangeSchema = z.object({
  kind: z.enum(DAILY_KINDS),
  cadence: z.enum(DAILY_CADENCES),
  from: day.optional(),
  unchanged: z.literal(true).optional(),
  unused: count,
});
export type DailyCadenceChange = z.infer<typeof dailyCadenceChangeSchema>;
