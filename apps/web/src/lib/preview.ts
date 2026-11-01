import {
  HOME_BLOCKS,
  INFO_SECTIONS,
  cardKey,
  composedLayoutOf,
  formatEventTime,
  formatNumber,
  homeBlocks,
  infoSections,
  isCardKey,
  listItems,
  playerTabs,
  questTypeShown,
  readEventLayout,
  readEventTexts,
  type AccentKey,
  type EventLooks,
  type HomeContent,
  type HomeKey,
  type InfoSection,
  type EventTexts,
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
/** One line of the ranking's example: made-up players, as the preview reads no real player. */
export type PreviewRankRow = Readonly<{ rank: number; username: string; score: string }>;

/** One section of the event info page as the preview draws it: its title and the lines it holds. */
export type PreviewInfoRow = Readonly<{
  section: InfoSection;
  title: MessageKey;
  lines: readonly string[];
}>;
/** The extra page as the preview draws it (T-613): its title and one line per part. */
export type PreviewPage = Readonly<{ title: string; lines: readonly string[] }>;

/** The player's Home, Quests and Shop screens for one event in one language (FR-1022). */
export type EventPreview = Readonly<{
  name: string;
  venue: string;
  accent: AccentKey | null;
  /** The labels the event renamed (FR-1843): the phone draws them in place of Questify's text. */
  texts: EventTexts;
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
  /** The info page's sections in the layout's order, without what the layout hides, a switch takes away or has nothing to draw. */
  info: readonly PreviewInfoRow[];
  /** The extra page, or null while there is none or its Home link is hidden. */
  page: PreviewPage | null;
  /** Home's Agenda and Maps buttons, which belong to its announcements block. */
  agendaButton: boolean;
  mapsButton: boolean;
  /** The Quests tab's List and Map toggle. */
  mapToggle: boolean;
  categories: readonly PreviewCategory[];
  /** The Rewards screen; null while the shop is off or the layout leaves the tab out, because no one can open it then. */
  rewards: readonly PreviewReward[] | null;
  /** How the ranking, Quests and Rewards screens are drawn (T-611). */
  looks: EventLooks;
  /** Example players for the ranking screen; null while the ranking is switched off, as the app has none then. */
  ranking: readonly PreviewRankRow[] | null;
}>;

const EXAMPLE_PLAYERS = [
  ["sara", 1240],
  ["omar", 1180],
  ["noor", 1105],
  ["khalid", 960],
  ["lina", 910],
  ["yazan", 840],
  ["huda", 790],
  ["faisal", 720],
] as const;

/** Eight example players with scores, in the language's digits: what the ranking screen looks like with a few players. */
const exampleRanking = (language: Language): readonly PreviewRankRow[] =>
  EXAMPLE_PLAYERS.map(([username, score], index) => ({
    rank: index + 1,
    username,
    score: formatNumber(score, language),
  }));

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

const nonEmpty = (lines: readonly string[]): string[] => lines.filter((line) => line !== "");

/** The extra page's title and one line per part, or null when the app would draw no link and no page (no title, no part). */
function pageOf(content: HomeContent, language: Language): PreviewPage | null {
  const page = content.page;
  const title = page === null ? "" : pickText(page.title, language);
  const lines =
    page === null
      ? []
      : page.blocks.flatMap((block) => {
          if (block.kind === "link") return [pickText(block.label, language)];
          if (block.kind === "list") return listItems(pickText(block.items, language));
          return [pickText(block.text, language)];
        });
  return title === "" || nonEmpty(lines).length === 0 ? null : { title, lines: nonEmpty(lines) };
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
  if (key === "page") return orNothing(nonEmpty([pageOf(content, context.language)?.title ?? ""]));
  return isCardKey(key) ? cardLines(key, content, context) : [];
}

type InfoContext = Readonly<{
  event: EventView;
  content: HomeContent;
  language: Language;
  hasRules: boolean;
}>;

/** The lines a section of the info page draws, or null when the app would draw nothing for it. */
function infoLines(
  section: InfoSection,
  { event, content, language, hasRules }: InfoContext,
): string[] | null {
  const lines: Readonly<Record<InfoSection, () => string[]>> = {
    about: () => nonEmpty([pickText(content.about, language)]),
    venue: () => nonEmpty([venueOf(event, language)]),
    when: () =>
      [event.startsAt, event.endsAt].map((iso) =>
        formatEventTime(new Date(iso), event.timezone, language),
      ),
    schedule: () => [],
    faq: () => nonEmpty(content.faq.map((entry) => pickText(entry.question, language))),
    contacts: () => nonEmpty(content.contacts.map((entry) => pickText(entry.label, language))),
    rules: () => [],
  };
  if (section === "rules" && !hasRules) {
    return null;
  }
  const found = lines[section]();
  const titleOnly = section === "schedule" || section === "rules";
  return found.length === 0 && !titleOnly ? null : found;
}

/** The bar and the Home blocks the event's layout leaves players, in its order, with the event's switches applied. */
function layoutParts(
  event: EventView,
  on: (feature: string) => boolean,
  language: Language,
  names: Names,
  hasRules: boolean,
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
  const context: InfoContext = { event, content: layout.content, language, hasRules };
  const info = infoSections(on, layout.info).flatMap((section) => {
    const lines = infoLines(section, context);
    const title = INFO_SECTIONS.find((entry) => entry.section === section)?.title;
    return lines === null || title === undefined ? [] : [{ section, title, lines }];
  });
  return {
    tabs: playerTabs(on, layout.bar).map(({ tab, title }) => ({ tab, title })),
    homeBlocks: blocks,
    info,
    page: pageOf(layout.content, language),
    announced: keys.includes("announcements"),
    looks: layout.looks,
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
 * `questTypeShown`), so a switch and a layout take away here exactly what they take away on the phone. The info page
 * draws its "Official rules" row only when the event has rules to show, as the app does (`hasRules`).
 */
export function previewOf(
  event: EventView,
  categories: readonly CategoryView[],
  rewards: readonly RewardView[],
  language: Language,
  hasRules = false,
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
  const {
    tabs,
    homeBlocks: blocks,
    info,
    page,
    announced,
    looks,
  } = layoutParts(event, on, language, names, hasRules);
  return {
    name: nameFor(event, language),
    venue: venueOf(event, language),
    accent: event.branding?.accent ?? null,
    texts: readEventTexts(event.texts),
    tabs,
    homeBlocks: blocks,
    info,
    page,
    agendaButton: on("agenda") && announced,
    mapsButton: on("maps") && announced,
    mapToggle: on("maps"),
    categories: previewCategories(categories, on, language),
    rewards: previewRewards(
      rewards,
      language,
      on("shop") && tabs.some((entry) => entry.tab === "rewards"),
    ),
    looks,
    ranking: on("ranking") ? exampleRanking(language) : null,
  };
}
