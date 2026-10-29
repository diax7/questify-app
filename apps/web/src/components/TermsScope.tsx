"use client";

import { DEFAULT_TERMS, type EventTerms, type Language } from "@questify/shared";
import { createContext, useContext, type ReactNode } from "react";
import { translatorFor, type Translate } from "#src/lib/language.ts";

const TermsContext = createContext<EventTerms>(DEFAULT_TERMS);

/**
 * Inside an event's pages, every text that names the quest, category or player word shows the event's (FR-942), so a
 * panel never passes them. Outside it, and on the console, Questify's own words stay.
 */
export function TermsScope({
  terms,
  children,
}: Readonly<{ terms: EventTerms; children: ReactNode }>) {
  return <TermsContext.Provider value={terms}>{children}</TermsContext.Provider>;
}

/**
 * The translator for a language with the surrounding event's words. The same words give the same function on every
 * render (see `translatorFor`), so it is safe in hook dependencies.
 */
export function useTranslator(language: Language): Translate {
  return translatorFor(language, useContext(TermsContext));
}

/** The surrounding event's words (Questify's own outside an event). */
export function useEventTerms(): EventTerms {
  return useContext(TermsContext);
}
