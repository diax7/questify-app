import {
  CURRENCY_ICONS,
  formatNumber,
  termFor,
  type CurrencyIcon,
  type EventTerms,
  type Language,
  type MessageKey,
} from "@questify/shared";
import type { Bonus } from "#src/event/quests-api.ts";
import { textIn } from "#src/i18n/text.ts";

type Translate = (key: MessageKey, params?: Readonly<Record<string, string | number>>) => string;

/** An icon this app version does not know shows the coin (F-282). */
export function knownIcon(icon: string): CurrencyIcon {
  return (CURRENCY_ICONS as readonly string[]).includes(icon) ? (icon as CurrencyIcon) : "coin";
}

/** An amount with the event's currency as its label: «جواهر: 120», "Gems: 120". `amount` is already formatted. */
export function amountLabel(
  t: Translate,
  terms: EventTerms,
  language: Language,
  amount: string,
): string {
  return t("quests.pointsShort", { currency: termFor(terms.currency, language), points: amount });
}

/** What a completion paid: «جواهر: ‎+10», "+10 gems" ("+1 gem"). */
export function completedText(
  t: Translate,
  terms: EventTerms,
  language: Language,
  points: number,
): string {
  return t("questsTab.completed", {
    currency: termFor(terms.currency, language, points),
    points: formatNumber(points, language),
  });
}

/** A category bonus in words: «أكملت «المرحلة»: مكافأة ‎+50», "+50 bonus: Stage complete" (FR-231). */
export function bonusLine(t: Translate, language: Language, bonus: Bonus): string {
  return t("questsTab.bonusPaid", {
    points: formatNumber(bonus.points, language),
    category: textIn(bonus.category, language),
  });
}

/** What a play paid, with the category bonus it paid after it when there is one. */
export function paidText(
  t: Translate,
  terms: EventTerms,
  language: Language,
  paid: Readonly<{ points: number; bonus: Bonus | null }>,
): string {
  const text = completedText(t, terms, language, paid.points);
  return paid.bonus === null ? text : `${text} ${bonusLine(t, language, paid.bonus)}`;
}
