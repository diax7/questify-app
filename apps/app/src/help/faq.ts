import { helpPublicSchema, shownHelp, type Language } from "@questify/shared";

export type FaqItem = Readonly<{
  id: string;
  question: string;
  answer: string;
  /** The language the text is in: the reader's, or the other one when the article exists in one language only. */
  language: Language;
}>;

/**
 * The published help articles of a `GET /v1/help` answer in the reader's language (FR-1782); an article written in one
 * language only is shown in that one. Undefined when the answer is not the expected shape.
 */
export function faqFrom(body: unknown, language: Language): FaqItem[] | undefined {
  const parsed = helpPublicSchema.safeParse(body);
  return parsed.success ? parsed.data.articles.map((item) => shownHelp(item, language)) : undefined;
}
