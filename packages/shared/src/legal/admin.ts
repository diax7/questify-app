import { z } from "zod";
import { LEGAL_DOCUMENT_IDS, LEGAL_VERSION } from "#src/legal/documents";

/**
 * The console's legal documents and help articles, and what the public reads of them (T-707, FR-1781, FR-1782). Wording is
 * data an admin edits; none of it is final legal copy (counsel's questions stay open, Q-288).
 */

/** Digits of any other script clash with the Western digits every screen uses (ADR-018). */
const OTHER_DIGITS = new RegExp(String.raw`[٠-٩۰-۹]`, "u");
export const ARABIC_LETTER = /\p{Script=Arabic}/u;
/** Control and direction characters; tab, new line and carriage return stay, as the texts have paragraphs. */
const UNSAFE = new RegExp(String.raw`(?![\t\n\r])\p{Cc}|[‎‏‪-‮⁦-⁩]`, "u");

export const LEGAL_TEXT_MAX = 100_000;
export const LEGAL_NOTE_MAX = 300;
export const HELP_QUESTION_MAX = 200;
export const HELP_ANSWER_MAX = 4000;
export const HELP_ID = /^[a-z][a-z0-9-]{0,63}$/;

/** A text that may be empty: trimmed, at most `max` characters, Western digits, no control or direction character. */
export const adminText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine((value) => !OTHER_DIGITS.test(value), "Western digits only")
    .refine((value) => !UNSAFE.test(value), "no control or direction characters");

const pair = (max: number) =>
  z
    .strictObject({ ar: adminText(max), en: adminText(max) })
    .refine((value) => !ARABIC_LETTER.test(value.en), {
      path: ["en"],
      message: "must be written in English",
    })
    .refine((value) => value.ar === "" || ARABIC_LETTER.test(value.ar), {
      path: ["ar"],
      message: "must be written in Arabic",
    });

const documentId = z.enum(LEGAL_DOCUMENT_IDS);
const version = z.string().regex(LEGAL_VERSION);
const instant = z.string();

// ---------------------------------------------------------------- legal documents

/** What an admin sends to publish a version: both texts are required. */
export const legalPublishSchema = z.strictObject({
  version,
  text: z.strictObject({
    ar: adminText(LEGAL_TEXT_MAX).refine(
      (value) => ARABIC_LETTER.test(value),
      "must be written in Arabic",
    ),
    en: adminText(LEGAL_TEXT_MAX).refine((value) => value !== "", "required"),
  }),
  note: adminText(LEGAL_NOTE_MAX).optional(),
});
export type LegalPublish = z.infer<typeof legalPublishSchema>;

/** `GET /v1/legal`: the version in force of each document. */
export const legalInForceSchema = z.strictObject({
  documents: z.array(z.strictObject({ document: documentId, version, publishedAt: instant })),
});

/** `GET /v1/legal/:document`: the document in force, with its texts (null when the version has none yet). */
export const legalTextSchema = z.strictObject({
  document: documentId,
  version,
  publishedAt: instant,
  ar: z.string().nullable(),
  en: z.string().nullable(),
});
export type LegalText = z.infer<typeof legalTextSchema>;

export const legalAdminListSchema = z.strictObject({
  documents: z.array(
    z.strictObject({
      document: documentId,
      versions: z.array(
        z.strictObject({
          version,
          publishedAt: instant,
          hasText: z.boolean(),
          note: z.string().nullable(),
          inForce: z.boolean(),
        }),
      ),
    }),
  ),
});
export type LegalAdminList = z.infer<typeof legalAdminListSchema>;

// ---------------------------------------------------------------- help and FAQ

/**
 * What an admin edits of an article. A language is complete (a question and its answer) or empty, and one language at
 * least is there: a reader of the other language is shown the one that exists.
 */
export const helpDocSchema = z
  .strictObject({
    question: pair(HELP_QUESTION_MAX),
    answer: pair(HELP_ANSWER_MAX),
    position: z.number().int().min(1).max(1000),
    published: z.boolean(),
  })
  .superRefine((doc, context) => {
    for (const language of ["ar", "en"] as const) {
      if ((doc.question[language] === "") !== (doc.answer[language] === "")) {
        context.addIssue({
          code: "custom",
          path: ["answer", language],
          message: "a language needs its question and its answer",
        });
      }
    }
    if (doc.question.ar === "" && doc.question.en === "") {
      context.addIssue({ code: "custom", path: ["question"], message: "write one language" });
    }
  });
export type HelpDoc = z.infer<typeof helpDocSchema>;

const stored = z.strictObject({ ar: z.string(), en: z.string() });

export const helpAdminSchema = z.strictObject({
  id: z.string().regex(HELP_ID),
  question: stored,
  answer: stored,
  position: z.number().int().min(1),
  published: z.boolean(),
  updatedAt: instant,
  revertible: z.boolean(),
});
export type HelpAdmin = z.infer<typeof helpAdminSchema>;
export const helpAdminListSchema = z.strictObject({ articles: z.array(helpAdminSchema) });

/** `GET /v1/help`: the published articles in order. */
export const helpPublicSchema = z.strictObject({
  articles: z.array(
    z.strictObject({ id: z.string().regex(HELP_ID), question: stored, answer: stored }),
  ),
});
export type HelpPublic = z.infer<typeof helpPublicSchema>;

/**
 * An article as one reader sees it: their language when the article has it, else the other language (FR-1782), with the
 * language it is shown in so the screen can set its direction.
 */
export function shownHelp(
  article: HelpPublic["articles"][number],
  language: "ar" | "en",
): Readonly<{ id: string; question: string; answer: string; language: "ar" | "en" }> {
  const shown = article.question[language] === "" ? (language === "ar" ? "en" : "ar") : language;
  return {
    id: article.id,
    question: article.question[shown],
    answer: article.answer[shown],
    language: shown,
  };
}
