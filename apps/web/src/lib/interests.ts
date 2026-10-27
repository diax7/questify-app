import {
  MAX_EVENT_INTERESTS,
  interestsSchema,
  type Interest,
  type Language,
} from "@questify/shared";

/** The interest list from `GET /v1/interests`; undefined when the answer is not the expected shape. */
export function readInterests(body: unknown): Interest[] | undefined {
  const parsed = interestsSchema.safeParse(body);
  return parsed.success ? parsed.data.interests : undefined;
}

/** An interest's name in the page's language, else the other one. */
export const interestName = (interest: Interest, language: Language): string =>
  interest.name[language] || interest.name[language === "ar" ? "en" : "ar"];

/**
 * The interests to offer: the list as sent, plus any the event holds that it no longer has (an interest removed from
 * the catalog later), so the form never silently drops one.
 */
export function interestChoices(
  interests: readonly Interest[],
  chosen: readonly string[],
): readonly Interest[] {
  const missing = chosen.filter((id) => !interests.some((interest) => interest.id === id));
  return [...missing.map((id) => ({ id, name: { ar: id, en: id } })), ...interests];
}

/** The chosen ids after one is ticked or unticked; a tick beyond the limit changes nothing. */
export function toggleInterest(chosen: readonly string[], id: string): readonly string[] {
  if (chosen.includes(id)) return chosen.filter((one) => one !== id);
  return chosen.length >= MAX_EVENT_INTERESTS ? chosen : [...chosen, id];
}
