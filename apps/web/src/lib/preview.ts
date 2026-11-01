import {
  HOME_BLOCKS,
  cardKey,
  composedLayoutOf,
  formatEventTime,
  formatNumber,
  homeBlocks,
  isCardKey,
  playerTabs,
  questTypeShown,
  readEventLayout,
  type AccentKey,
  type HomeContent,
  type HomeKey,
  type Language,
  type MessageKey,
  type PlayerTab,
} from "@questify/shared";
import { nameFor, type EventView } from "#src/lib/events.ts";
import { pickText } from "#src/lib/home-content-editor.ts";
import type { CategoryView, QuestView } from "#src/lib/quests.ts";
import type { RewardView } from "#src/lib/rewards.ts";

/** What the player's screens show of one quest in the preview. */
export type PreviewQuest = Readonly<{ id: string; title: string; points: string }>;
export type PreviewCategory = Readonly<{
  id: string;
  name: string;
  quests: readonly PreviewQuest[];
}>;
export type PreviewReward = Readonly<{ id: string; name: string; price: string }>;

/** The player's Home, Quests and Shop screens for one event in one language (FR-1022). */
export type EventPreview = Readonly<{
  name: string;
  venue: string;
  accent: AccentKey | null;
  /** The bar's items in the layout's order, without what the layout hides or a switch takes away. */
  tabs: readonly Readonly<{ tab: PlayerTab; title: MessageKey }>[];
  /**
   * Home's blocks in the layout's order, without what the layout hides, a switch takes away or has nothing to draw (T-606,
   * T-610). A block of Questify's has its title; one of the organizer's cards has none and is drawn by its lines.
   */
  homeBlocks: readonly Readonly<{
    block: HomeKey;
    title: MessageKey | null;
    lines: readonly string[];
  }>[];
  /** Home's Agenda and Maps buttons, which belong to its announcements block. */
  agendaButton: boolean;
  mapsButton: boolean;
  /** The Quests tab's List and Map toggle. */
  mapToggle: boolean;
  categories: readonly PreviewCategory[];
  /** The Rewards screen; null while the shop is off or the layout leaves the tab out, because no one can open it then. */
  rewards: readonly PreviewReward[] | null;
}>;

/**
 * The event's switches as one lookup, read the way the app reads them: a switch the API did not send counts as on
 * (quest ratings are the one that starts off).
 */
export function featureLookup(event: EventView): (feature: string) => boolean {
  const switches: Readonly<Record<string, boolean | undefined>> = {
    ranking: event.ranking,
    rankingToday: event.rankingToday,
    shareQuests: event.shareQuests,
    meetSomeone: event.meetSomeone,
    miniGames: event.miniGames,
    community: event.community,
    flashQuests: event.flashQuests,
    boosts: event.boosts,
    helpDesk: event.helpDesk,
    questRatings: event.questRatings ?? false,
    shop: event.shop,
    polls: event.polls,
    maps: event.maps,
    agenda: event.agenda,
  };
  return (feature) => switches[feature] ?? true;
}

/** A live poll shows as a card over the tabs, never as a row of the Quests tab (ADR-220). */
const isLivePoll = (quest: QuestView): boolean => quest.type === "vote" && "live" in quest.config;

/** Whether players see this quest on the Quests tab: visible, not a live poll, its type and flash switches on. */
function shownToPlayers(quest: QuestView, on: (feature: string) => boolean): boolean {
  return (
    quest.visible &&
    !isLivePoll(quest) &&
    questTypeShown(quest.type, on) &&
    (quest.flash !== true || on("flashQuests"))
  );
}

function titleOf(quest: QuestView, language: Language): string {
  return quest.title[language] ?? quest.title.en ?? quest.title.ar ?? "";
}

/** What the quest and reward pickers can name, for the featured card's line. */
type Names = Readonly<{
  quest: (id: string) => string | null;
  reward: (id: string) => string | null;
}>;

const SWITCHED_SCREENS = ["agenda", "maps", "shop"];

type LineContext = Readonly<{
  language: Language;
  zone: string;
  names: Names;
  on: (feature: string) => boolean;
}>;

const orNothing = (lines: readonly string[]): string[] | null =>
  lines.length === 0 ? null : [...lines];

function quickLinkLines(content: HomeContent, { language, on }: LineContext): string[] | null {
  const shown = content.quickLinks.filter(
    (link) => !SWITCHED_SCREENS.includes(link.action.type) || on(link.action.type),
  );
  return orNothing(shown.map((link) => pickText(link.label, language)));
}

function featuredLines(content: HomeContent, { names }: LineContext): string[] | null {
  const target = content.featured;
  const name = target === null ? null : names[target.kind](target.id);
  return name === null ? null : [name];
}

function cardLines(key: HomeKey, content: HomeContent, context: LineContext): string[] | null {
  const card = content.cards.find((entry) => cardKey(entry.id) === key);
  if (card === undefined) {
    return null;
  }
  const { language, zone } = context;
  return card.kind === "text"
    ? [pickText(card.title, language), pickText(card.body, language)].filter((line) => line !== "")
    : [pickText(card.label, language), formatEventTime(new Date(card.at), zone, language)];
}

/** The lines a block draws, or null when the app would draw nothing for it (no slides, no links, a missing item). */
function contentLines(key: HomeKey, content: HomeContent, context: LineContext): string[] | null {
  if (key === "banner") {
    return orNothing(content.banner.map((slide) => pickText(slide.title, context.language)));
  }
  if (key === "quickLinks") return quickLinkLines(content, context);
  if (key === "featured") return featuredLines(content, context);
  return isCardKey(key) ? cardLines(key, content, context) : [];
}

/** The bar and the Home blocks the event's layout leaves players, in its order, with the event's switches applied. */
function layoutParts(
  event: EventView,
  on: (feature: string) => boolean,
  language: Language,
  names: Names,
) {
  const layout = composedLayoutOf(readEventLayout(event.layout));
  const keys = homeBlocks(on, layout.home);
  const blocks = keys.flatMap((block) => {
    const lines = contentLines(block, layout.content, {
      language,
      zone: event.timezone,
      names,
      on,
    });
    const title = HOME_BLOCKS.find((entry) => entry.block === block)?.title ?? null;
    return lines === null ? [] : [{ block, title, lines }];
  });
  return {
    tabs: playerTabs(on, layout.bar).map(({ tab, title }) => ({ tab, title })),
    homeBlocks: blocks,
    announced: keys.includes("announcements"),
  };
}

function previewCategories(
  categories: readonly CategoryView[],
  on: (feature: string) => boolean,
  language: Language,
): readonly PreviewCategory[] {
  return categories
    .filter((category) => !category.hidden)
    .map((category) => ({
      id: category.id,
      name: category.name[language] ?? category.name.en ?? category.name.ar ?? "",
      quests: category.quests
        .filter((quest) => shownToPlayers(quest, on))
        .map((quest) => ({
          id: quest.id,
          title: titleOf(quest, language),
          points: formatNumber(quest.points, language),
        })),
    }))
    .filter((category) => category.quests.length > 0);
}

/** The Rewards screen's lines, or null when no one can open it (the shop is off, or the layout leaves its tab out). */
const previewRewards = (
  rewards: readonly RewardView[],
  language: Language,
  reachable: boolean,
): readonly PreviewReward[] | null =>
  reachable
    ? rewards.map((reward) => ({
        id: reward.id,
        name: reward.name[language] ?? reward.name.en ?? reward.name.ar ?? "",
        price: formatNumber(reward.price, language),
      }))
    : null;

const venueOf = (event: EventView, language: Language): string =>
  event.venue[language] ?? event.venue.en ?? event.venue.ar ?? "";

/**
 * Builds the preview from what the team's pages read: the same rules as the app's own reads (`playerTabs`, `homeBlocks`,
 * `questTypeShown`), so a switch and a layout take away here exactly what they take away on the phone.
 */
export function previewOf(
  event: EventView,
  categories: readonly CategoryView[],
  rewards: readonly RewardView[],
  language: Language,
): EventPreview {
  const on = featureLookup(event);
  const names: Names = {
    quest: (id) => {
      const quest = categories
        .flatMap((category) => category.quests)
        .find((entry) => entry.id === id);
      return quest === undefined ? null : titleOf(quest, language);
    },
    reward: (id) => {
      const reward = rewards.find((entry) => entry.id === id);
      return reward === undefined
        ? null
        : (reward.name[language] ?? reward.name.en ?? reward.name.ar ?? "");
    },
  };
  const { tabs, homeBlocks: blocks, announced } = layoutParts(event, on, language, names);
  return {
    name: nameFor(event, language),
    venue: venueOf(event, language),
    accent: event.branding?.accent ?? null,
    tabs,
    homeBlocks: blocks,
    agendaButton: on("agenda") && announced,
    mapsButton: on("maps") && announced,
    mapToggle: on("maps"),
    categories: previewCategories(categories, on, language),
    rewards: previewRewards(
      rewards,
      language,
      on("shop") && tabs.some((entry) => entry.tab === "rewards"),
    ),
  };
}
