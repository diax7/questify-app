import type { MessageKey } from "#src/i18n/messages";

/** The quest types an event switch hides, by the feature's key (FR-219, FR-1009; ADR-199, ADR-210, ADR-213). */
export const QUEST_TYPE_SWITCHES: Readonly<Record<string, string>> = {
  share: "shareQuests",
  meet: "meetSomeone",
  game: "miniGames",
};

/** Whether players see a quest of this type, given whether each event feature is on. */
export function questTypeShown(type: string, featureOn: (feature: string) => boolean): boolean {
  const feature = QUEST_TYPE_SWITCHES[type];
  return feature === undefined || featureOn(feature);
}

export type PlayerTab = "index" | "quests" | "scan" | "rewards" | "profile";

/** The event bar's tabs in order, each with its title and the feature that carries it (null: always there; FR-620). */
export const PLAYER_TABS: readonly Readonly<{
  tab: PlayerTab;
  title: MessageKey;
  feature: string | null;
}>[] = [
  { tab: "index", title: "nav.home", feature: null },
  { tab: "quests", title: "nav.quests", feature: null },
  { tab: "scan", title: "nav.scan", feature: null },
  { tab: "rewards", title: "nav.rewards", feature: "shop" },
  { tab: "profile", title: "nav.profile", feature: null },
];

/**
 * The tabs a player's event bar shows: the Rewards tab goes with the shop switch. The app's bar and the dashboard's preview
 * both read this, so they cannot disagree about what a switch takes away (FR-1022).
 */
export function playerTabs(featureOn: (feature: string) => boolean): typeof PLAYER_TABS {
  return PLAYER_TABS.filter((entry) => entry.feature === null || featureOn(entry.feature));
}
