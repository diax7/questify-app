import {
  WORD_LIST_MAX,
  dailyChallengeBodySchema,
  dailyQuestionBodySchema,
  normalizeWord,
  type AdminDailyQuestion,
  type DailyChallengeBody,
  type DailyLanguage,
  type DailyQuestionBody,
} from "@questify/shared";

export type Checked<T, Field extends string> =
  | Readonly<{ ok: true; body: T }>
  | Readonly<{ ok: false; field: Field }>;

// ================================================================ the question bank

export type QuestionDraft = Readonly<{
  promptAr: string;
  promptEn: string;
  options: ReadonlyArray<Readonly<{ ar: string; en: string }>>;
  /** The 1-based place of the right option, as chosen in the form. */
  answer: string;
}>;

export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 4;
const BLANK_OPTION = { ar: "", en: "" } as const;

export const BLANK_QUESTION: QuestionDraft = {
  promptAr: "",
  promptEn: "",
  options: [BLANK_OPTION, BLANK_OPTION],
  answer: "1",
};

export const questionDraftOf = (question: AdminDailyQuestion): QuestionDraft => ({
  promptAr: question.prompt.ar,
  promptEn: question.prompt.en,
  options: question.options,
  answer: String(question.answer),
});

export type QuestionField = "prompt" | "options" | "answer";
const QUESTION_FIELDS: ReadonlySet<string> = new Set(["prompt", "options", "answer"]);

/** Checks a question form with the schema the API uses, before anything is sent. */
export function questionBodyOf(draft: QuestionDraft): Checked<DailyQuestionBody, QuestionField> {
  const parsed = dailyQuestionBodySchema.safeParse({
    prompt: { ar: draft.promptAr, en: draft.promptEn },
    options: draft.options,
    answer: /^[1-4]$/.test(draft.answer) ? Number(draft.answer) : Number.NaN,
  });
  if (parsed.success) {
    return { ok: true, body: parsed.data };
  }
  const first = parsed.error.issues[0]?.path[0];
  return {
    ok: false,
    field: QUESTION_FIELDS.has(String(first)) ? (first as QuestionField) : "prompt",
  };
}

/** A question is free to schedule: ready, and in no challenge, or in the one being edited. */
export const canPick = (question: AdminDailyQuestion, day: string | null): boolean =>
  question.status === "ready" && (question.scheduledOn === null || question.scheduledOn === day);

// ================================================================ a period's challenge

export type ChallengeDraft = Readonly<{
  /** The three questions by id, in order; "" for one not chosen yet. */
  questionIds: readonly [string, string, string];
  sponsorAr: string;
  sponsorEn: string;
}>;

export const BLANK_CHALLENGE: ChallengeDraft = {
  questionIds: ["", "", ""],
  sponsorAr: "",
  sponsorEn: "",
};

/** The draft a period's editor opens with, from the challenge it holds. */
export function challengeDraftOf(
  questions: readonly string[],
  sponsor: Readonly<{ ar: string; en: string }> | null,
): ChallengeDraft {
  const [first = "", second = "", third = ""] = questions;
  return {
    questionIds: [first, second, third],
    sponsorAr: sponsor?.ar ?? "",
    sponsorEn: sponsor?.en ?? "",
  };
}

export type ChallengeField = "questions" | "sponsor";

/** Checks a challenge form: three different questions; a sponsor in both languages or in neither. */
export function challengeBodyOf(
  draft: ChallengeDraft,
): Checked<DailyChallengeBody, ChallengeField> {
  const sponsorAr = draft.sponsorAr.trim();
  const sponsorEn = draft.sponsorEn.trim();
  const parsed = dailyChallengeBodySchema.safeParse({
    questionIds: draft.questionIds,
    sponsor:
      sponsorAr === "" && sponsorEn === "" ? null : { name: { ar: sponsorAr, en: sponsorEn } },
  });
  return parsed.success
    ? { ok: true, body: parsed.data }
    : { ok: false, field: parsed.error.issues[0]?.path[0] === "sponsor" ? "sponsor" : "questions" };
}

// ================================================================ a period's word

/** Checks a daily word before it is sent: exactly five letters of the language once normalized. */
export function wordBodyOf(
  language: DailyLanguage,
  text: string,
): Checked<Readonly<{ word: string }>, "word"> {
  const word = text.trim();
  return normalizeWord(language, word) === null
    ? { ok: false, field: "word" }
    : { ok: true, body: { word } };
}

// ================================================================ the guess list import

/** A longer line is never a word and would fail the whole call, so it is held back here. */
const MAX_LINE = 40;
/** The API reports at most this many refused inputs. */
export const REFUSED_SHOWN = 50;
/** How many too-long lines are quoted back. */
const LONG_SHOWN = 5;

export type ImportLines = Readonly<{
  /** The distinct lines to send, in order. */
  words: readonly string[];
  /** The count of lines held back for being too long. */
  tooLong: number;
  /** The first few of them, cut to the length the API takes, so the admin can find them. */
  longSamples: readonly string[];
}>;

/** The lines of a pasted list: one word per line, blank lines and repeats dropped. */
export function parseWordLines(text: string): ImportLines {
  const seen = new Set<string>();
  const longSamples: string[] = [];
  let tooLong = 0;
  for (const line of text.split(/\r\n|\r|\n/)) {
    const word = line.trim();
    if (word === "") {
      continue;
    }
    if ([...word].length > MAX_LINE) {
      tooLong += 1;
      if (longSamples.length < LONG_SHOWN) {
        longSamples.push(`${[...word].slice(0, MAX_LINE).join("")}…`);
      }
    } else {
      seen.add(word);
    }
  }
  return { words: [...seen], tooLong, longSamples };
}

/** The calls a list needs: the API takes at most `WORD_LIST_MAX` words in one. */
export function chunkWords(words: readonly string[]): string[][] {
  const calls: string[][] = [];
  for (let start = 0; start < words.length; start += WORD_LIST_MAX) {
    calls.push(words.slice(start, start + WORD_LIST_MAX));
  }
  return calls;
}

/** The refused lines to show: the first ones across every call, no more than the API itself would show. */
export const shownRefusals = (refused: readonly string[]): string[] =>
  refused.slice(0, REFUSED_SHOWN);
