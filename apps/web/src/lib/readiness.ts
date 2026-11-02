import {
  SETUP_STEP_COUNT,
  formatNumber,
  type Language,
  type ReadinessItem,
  type ReadinessKey,
  type ReadinessStatus,
} from "@questify/shared";
import type { Translate } from "#src/lib/language.ts";
import type { IconName } from "#src/ui/Icon.tsx";

/**
 * Where each item of the go-live checklist is fixed, after the event's own address: "" is the Overview (the hash lands on
 * the card there that holds it), the rest are the event's pages. Quests are set in the builder, rewards and the prize
 * desk place on the Rewards page, the official rules on the Prizes and rules page (`PrizesPanel`) and the join method on
 * the Joining page.
 */
export const READINESS_PAGES: Readonly<Record<ReadinessKey, string>> = {
  dates: "",
  activation: "#activation-title",
  quests: "/quests",
  rewards: "/rewards",
  desk: "/rewards",
  operators: "/operators",
  join: "/joining",
  rules: "/prizes",
  bigScreen: "/big-screen",
  devices: "/devices",
  rehearsal: "#rehearsal-title",
  branding: "",
  setup: "/setup",
};

/** The address that fixes an item, from the event's address (`/en/organizers/…/events/…`). */
export const readinessHref = (eventBase: string, key: ReadinessKey): string =>
  `${eventBase}${READINESS_PAGES[key]}`;

/** The icon of a status: a tick for done, a triangle for a warning, a barred circle for blocking. */
export const STATUS_ICON: Readonly<Record<ReadinessStatus, IconName>> = {
  done: "check",
  warning: "alert",
  blocking: "blocked",
};

/** The item's title, in the event's own words (a quest is what the event calls it). */
export const itemTitle = (t: Translate, item: ReadinessItem): string =>
  t(`readiness.item.${item.key}`);

/** What the item reads now: a state, or a state with its number (Western digits in both languages). */
export const itemLine = (t: Translate, item: ReadinessItem, language: Language): string =>
  t(`readiness.line.${item.line}`, {
    count: formatNumber(item.count, language),
    total: formatNumber(SETUP_STEP_COUNT, language),
  });

/** Blocking first, then warnings, then what is done: the order a person works through the list, stable inside a status. */
export function byUrgency(items: readonly ReadinessItem[]): readonly ReadinessItem[] {
  const rank: Readonly<Record<ReadinessStatus, number>> = { blocking: 0, warning: 1, done: 2 };
  return items
    .map((item, index) => ({ item, index }))
    .toSorted((a, b) => rank[a.item.status] - rank[b.item.status] || a.index - b.index)
    .map(({ item }) => item);
}
