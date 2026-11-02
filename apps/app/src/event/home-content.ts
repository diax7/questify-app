import {
  linkHost,
  type BannerSlide,
  type CountdownCard,
  type FeaturedTarget,
  type Language,
  type LocalText,
  type MessageKey,
  type TapAction,
} from "@questify/shared";
import { spanText } from "#src/event/countdown.ts";
import type { QuestsView } from "#src/event/quests-api.ts";
import type { ShopView } from "#src/event/shop-api.ts";

/** How long a banner slide stays before the next one, and how far a finger must travel to count as a swipe. */
export const SLIDE_MS = 5000;
export const SWIPE_PX = 40;

/** The words in the screen's language, else in the other one, else nothing. */
export function localIn(text: LocalText, language: Language): string {
  const other = language === "ar" ? text.en : text.ar;
  return text[language] === "" ? other : text[language];
}

/** Where a tap on a banner slide, a quick link or the featured card leads (T-610, FR-1828, FR-1829). */
export type TapOutcome =
  | Readonly<{ kind: "agenda" | "maps" | "shop" }>
  | Readonly<{ kind: "quest"; questId: string }>
  | Readonly<{ kind: "link"; url: string; host: string }>;

const SWITCH_OF = { agenda: "agenda", maps: "maps", shop: "shop" } as const;

/**
 * What a tap does, or null when it does nothing: no action, or a screen whose event switch is off (a layout never turns a
 * feature back on). A link carries its host, which the player is shown before the browser opens.
 */
export function tapOutcome(
  action: TapAction,
  featureOn: (feature: string) => boolean,
): TapOutcome | null {
  switch (action.type) {
    case "agenda":
    case "maps":
    case "shop":
      return featureOn(SWITCH_OF[action.type]) ? { kind: action.type } : null;
    case "quest":
      return { kind: "quest", questId: action.questId };
    case "link":
      return { kind: "link", url: action.url, host: linkHost(action.url) };
    default:
      return null;
  }
}

/** The slide after a step, wrapping round; a single slide stays where it is. */
export function nextSlide(index: number, count: number, step: 1 | -1): number {
  return count <= 1 ? 0 : (index + step + count) % count;
}

/** The step a horizontal drag asks for: forward is a drag towards the start of the line (left in English, right in Arabic). */
export function swipeStep(dx: number, rtl: boolean): 0 | 1 | -1 {
  if (Math.abs(dx) < SWIPE_PX) {
    return 0;
  }
  return (rtl ? dx > 0 : dx < 0) ? 1 : -1;
}

/** What a screen reader says for one slide of a slider: its place, then its title and subtitle. */
export function slideLabel(place: string, slide: BannerSlide, language: Language): string {
  return [place, localIn(slide.title, language), localIn(slide.subtitle, language)]
    .filter((part) => part !== "")
    .join(". ");
}

/** Dots mark the slides only when there is more than one. */
export const showDots = (count: number): boolean => count > 1;

export type CountdownView =
  | Readonly<{ kind: "counting"; label: string; span: string | null }>
  | Readonly<{ kind: "message"; label: string; message: string }>
  | Readonly<{ kind: "hidden" }>;

/**
 * A countdown card on this clock (the phone's, corrected by the server's offset): the time left, or at zero its message or
 * nothing. A span under a minute is null, and the card says so in words. A card told to show a message it does not have hides.
 */
export function countdownView(card: CountdownCard, now: number, language: Language): CountdownView {
  const label = localIn(card.label, language);
  const left = Date.parse(card.at) - now;
  if (left > 0) {
    return { kind: "counting", label, span: spanText(left, language) };
  }
  const message = card.atZero === "message" ? localIn(card.message, language) : "";
  return message === "" ? { kind: "hidden" } : { kind: "message", label, message };
}

/** When the card's view next changes: a minute from now while counting, the moment itself when it is within the minute. */
export function countdownRefreshMs(card: CountdownCard, now: number): number | null {
  const left = Date.parse(card.at) - now;
  return left <= 0 ? null : Math.min(30_000, left + 1000);
}

type Words = Readonly<{ ar: string | null; en: string | null }>;

/** The featured quest or reward as the card draws it; a quest that cannot be played now carries the words that say why. */
export type FeaturedView =
  | Readonly<{ kind: "quest"; id: string; title: Words; points: number; note: MessageKey | null }>
  | Readonly<{ kind: "reward"; id: string; title: Words; points: number }>;

/** What a featured quest says while it is not open; an open quest, and a state this build does not know, say nothing. */
const QUEST_NOTES: Readonly<Record<string, MessageKey | undefined>> = {
  paused: "questsTab.paused",
  locked: "questsTab.locked",
  not_live: "questsTab.notLive",
  not_yet: "questsTab.notLive",
  closed: "questsTab.notLive",
};

type QuestEntry = QuestsView["categories"][number]["quests"][number];

const featuredQuest = (quest: QuestEntry | undefined): FeaturedView | null =>
  quest === undefined || quest.state === "done"
    ? null
    : {
        kind: "quest",
        id: quest.id,
        title: quest.title,
        points: quest.points,
        note: QUEST_NOTES[quest.state] ?? null,
      };

/**
 * The featured item from the player's own reads: a quest they have not finished, or a reward still in stock. An item that is
 * not in their lists (removed, hidden, another event's id) gives null, so a stale pick draws nothing.
 */
export function featuredView(
  target: FeaturedTarget,
  quests: QuestsView | undefined,
  shop: ShopView | undefined,
): FeaturedView | null {
  if (target.kind === "quest") {
    return featuredQuest(
      quests?.categories
        .flatMap((category) => category.quests)
        .find((entry) => entry.id === target.id),
    );
  }
  const reward = shop?.rewards.find((entry) => entry.id === target.id);
  return reward === undefined || reward.stockLeft <= 0
    ? null
    : { kind: "reward", id: reward.id, title: reward.name, points: reward.price };
}
