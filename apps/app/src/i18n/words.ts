import {
  withEventTexts,
  wordParams,
  type EventTerms,
  type EventTexts,
  type Language,
  type MessageKey,
} from "@questify/shared";

export type Translate = (
  key: MessageKey,
  params?: Readonly<Record<string, string | number>>,
) => string;

/**
 * The translator with an event's quest and category words filled into every text that names them (FR-942). The
 * words are the base: a screen's own values for the same names win.
 */
export function withWords(translate: Translate, terms: EventTerms, language: Language): Translate {
  const words = wordParams(terms, language);
  return (key, params) => translate(key, { ...words, ...params });
}

/**
 * The translator inside an event (FR-942, FR-1843): the labels the event renamed take the place of Questify's text, and the
 * event's quest, category and player words are filled into every text that names them, the renamed labels included. A
 * language or label the event did not rename shows the parent's text.
 */
export function withEventWords(
  translate: Translate,
  terms: EventTerms,
  texts: EventTexts,
  language: Language,
): Translate {
  return withWords(withEventTexts(translate, texts, language), terms, language);
}
