import {
  CURRENCY_ICONS,
  formatNumber,
  termFor,
  type CurrencyIcon,
  type EventTerms,
  type Language,
  type MessageKey,
} from "@questify/shared";

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
