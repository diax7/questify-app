import type { Language, MessageKey } from "@questify/shared";
import { formatNumber } from "@questify/shared";
import type { Translate } from "#src/i18n/words.ts";

/** Whether the gems stand as the sentence's subject («لديك جوهرتان») or follow a preposition or verb («على جوهرتين»). */
export type GemsRole = "subject" | "object";

/**
 * The message that counts gems for this number: English one or many; Arabic one, two (nominative or oblique by role),
 * 3 to 10, and the rest (11 and over take the singular noun, as 11 to 99 and every hundred do).
 */
export function gemsKey(count: number, language: Language, role: GemsRole = "object"): MessageKey {
  if (count === 1) return "gems.one";
  if (language === "en") return "gems.many";
  if (count === 2) return role === "subject" ? "gems.two" : "gems.twoObject";
  if (count === 0) return "gems.few";
  const lastTwo = count % 100;
  return lastTwo >= 3 && lastTwo <= 10 ? "gems.few" : "gems.many";
}

/** "1 gem", "20 gems", «جوهرتان», «5 جواهر», «20 جوهرة»: Western digits, the noun in the right Arabic form. */
export function gemsLabel(
  t: Translate,
  count: number,
  language: Language,
  role: GemsRole = "object",
): string {
  return t(gemsKey(count, language, role), { count: formatNumber(count, language) });
}
