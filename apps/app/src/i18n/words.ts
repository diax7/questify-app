import { wordParams, type EventTerms, type Language, type MessageKey } from "@questify/shared";

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
