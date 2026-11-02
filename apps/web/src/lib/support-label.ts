import type { Language } from "@questify/shared";
import { translatorFor } from "#src/lib/language.ts";

/** What the API shows in place of a Questify admin's email for work done under a support grant (Q-374). */
export const SUPPORT_MARKER = "questify-support";

/** A staff member's name as the dashboard shows it: "Questify support" for the marker, else the name itself. */
export function staffShown(name: string, language: Language): string;
export function staffShown(name: string | null, language: Language): string | null;
export function staffShown(name: string | null, language: Language): string | null {
  return name === SUPPORT_MARKER ? translatorFor(language)("support.questify") : name;
}
