import type { ForYouEvent, Language } from "@questify/shared";

/** An event's name in the screen's language, else the other one, else its join code (an event needs only one name). */
export function eventTitle(
  event: Pick<ForYouEvent, "name" | "joinCode">,
  language: Language,
): string {
  const other = language === "ar" ? event.name.en : event.name.ar;
  return event.name[language] ?? other ?? event.joinCode;
}
