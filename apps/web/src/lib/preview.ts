import {
  HOME_BLOCKS,
  composedLayoutOf,
  formatNumber,
  homeBlocks,
  playerTabs,
  questTypeShown,
  readEventLayout,
  type AccentKey,
  type HomeBlock,
  type Language,
  type MessageKey,
  type PlayerTab,
} from "@questify/shared";
import { nameFor, type EventView } from "#src/lib/events.ts";
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
  /** Home's blocks in the layout's order, without what the layout hides or a switch takes away (T-606). */
  homeBlocks: readonly Readonly<{ block: HomeBlock; title: MessageKey }>[];
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

/** The bar and the Home blocks the event's layout leaves players, in its order, with the event's switches applied. */
function layoutParts(event: EventView, on: (feature: string) => boolean) {
  const layout = composedLayoutOf(readEventLayout(event.layout));
  const blocks = homeBlocks(on, layout.home);
  return {
    tabs: playerTabs(on, layout.bar).map(({ tab, title }) => ({ tab, title })),
    homeBlocks: blocks.map((block) => ({
      block,
      title: HOME_BLOCKS.find((entry) => entry.block === block)?.title ?? "layout.home",
    })),
    announced: blocks.includes("announcements"),
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
  const { tabs, homeBlocks: blocks, announced } = layoutParts(event, on);
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
