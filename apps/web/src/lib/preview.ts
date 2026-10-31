import {
  formatNumber,
  playerTabs,
  questTypeShown,
  type AccentKey,
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
  tabs: readonly Readonly<{ tab: PlayerTab; title: MessageKey }>[];
  /** Home's ranking card, its Agenda and Maps buttons. */
  rankingCard: boolean;
  agendaButton: boolean;
  mapsButton: boolean;
  /** The Quests tab's List and Map toggle. */
  mapToggle: boolean;
  categories: readonly PreviewCategory[];
  /** The Rewards screen; null while the shop is off, because the app has no such screen then. */
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

/**
 * Builds the preview from what the team's pages read: the same rules as the app's own reads (`playerTabs`,
 * `questTypeShown`), so a switch takes away here exactly what it takes away on the phone.
 */
export function previewOf(
  event: EventView,
  categories: readonly CategoryView[],
  rewards: readonly RewardView[],
  language: Language,
): EventPreview {
  const on = featureLookup(event);
  const shown = categories
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
  return {
    name: nameFor(event, language),
    venue: event.venue[language] ?? event.venue.en ?? event.venue.ar ?? "",
    accent: event.branding?.accent ?? null,
    tabs: playerTabs(on).map(({ tab, title }) => ({ tab, title })),
    rankingCard: on("ranking"),
    agendaButton: on("agenda"),
    mapsButton: on("maps"),
    mapToggle: on("maps"),
    categories: shown,
    rewards: on("shop")
      ? rewards.map((reward) => ({
          id: reward.id,
          name: reward.name[language] ?? reward.name.en ?? reward.name.ar ?? "",
          price: formatNumber(reward.price, language),
        }))
      : null,
  };
}
