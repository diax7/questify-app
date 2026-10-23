import {
  CURRENCY_ICONS,
  formatNumber,
  termFor,
  type CurrencyIcon,
  type EventTerms,
  type Language,
  type MessageKey,
} from "@questify/shared";
import type { Bonus, ItemGiven, ItemOutcome } from "#src/event/quests-api.ts";
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

const ITEM_TEXT: Readonly<Record<ItemOutcome, MessageKey>> = {
  pending: "questsTab.itemPending",
  out_of_stock: "questsTab.itemOut",
  claim_closed: "questsTab.itemClosed",
};

/**
 * A quest item in words (FR-522, FR-1617): «‎+ قميص: استلم جائزتك من مكتب الجوائز», "+ T-shirt: collect it at the prize
 * desk"; when it ran out or the desk closed, that the points were paid.
 */
export function itemLine(t: Translate, language: Language, item: ItemGiven): string {
  return t(ITEM_TEXT[item.outcome], { item: textIn(item.name, language) });
}

/**
 * A category bonus in words: «أكملت «المرحلة»: مكافأة ‎+50», "+50 bonus: Stage complete" (FR-231); an item-only bonus
 * says the category is complete; its item follows (T-304d).
 */
export function bonusLine(t: Translate, language: Language, bonus: Bonus): string {
  const category = textIn(bonus.category, language);
  const text =
    bonus.points > 0
      ? t("questsTab.bonusPaid", { points: formatNumber(bonus.points, language), category })
      : t("questsTab.categoryDone", { category });
  return bonus.item === null ? text : `${text} ${itemLine(t, language, bonus.item)}`;
}

/** What a play paid, with its quest item and the category bonus it paid after it when there are. */
export function paidText(
  t: Translate,
  terms: EventTerms,
  language: Language,
  paid: Readonly<{ points: number; bonus: Bonus | null; item: ItemGiven | null }>,
): string {
  const lines = [completedText(t, terms, language, paid.points)];
  if (paid.item !== null) {
    lines.push(itemLine(t, language, paid.item));
  }
  if (paid.bonus !== null) {
    lines.push(bonusLine(t, language, paid.bonus));
  }
  return lines.join(" ");
}
