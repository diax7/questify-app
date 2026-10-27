import { formatNumber, type Language, type MessageKey } from "@questify/shared";
import type { Translate } from "#src/i18n/words.ts";

/** Whether the days stand as the sentence's subject («يومان على التوالي») or follow a noun or preposition («سلسلة يومين»). */
export type DaysRole = "subject" | "object";

/**
 * The message that counts days for this number: English one or many; Arabic one, two (nominative or oblique by role),
 * 3 to 10, and the rest (11 and over take the singular noun, as 11 to 99 and every hundred do).
 */
export function daysKey(count: number, language: Language, role: DaysRole = "object"): MessageKey {
  if (count === 1) return "streak.days.one";
  if (language === "en") return "streak.days.many";
  if (count === 2) return role === "subject" ? "streak.days.two" : "streak.days.twoObject";
  if (count === 0) return "streak.days.few";
  const lastTwo = count % 100;
  return lastTwo >= 3 && lastTwo <= 10 ? "streak.days.few" : "streak.days.many";
}

/** "1 day", "20 days", «يوم واحد», «يومان», «5 أيام», «20 يومًا»: Western digits, the noun in the right Arabic form. */
export function daysLabel(
  t: Translate,
  count: number,
  language: Language,
  role: DaysRole = "object",
): string {
  return t(daysKey(count, language, role), { count: formatNumber(count, language) });
}
