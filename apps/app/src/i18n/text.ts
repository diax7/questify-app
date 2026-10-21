import type { Language } from "@questify/shared";

/** Words an organizer wrote in either language, or both. */
export type Bilingual = Readonly<{ ar: string | null; en: string | null }>;

/** The words in the screen's language, else in the other one, else nothing. */
export const textIn = (text: Bilingual, language: Language): string =>
  text[language] ?? text[language === "ar" ? "en" : "ar"] ?? "";
