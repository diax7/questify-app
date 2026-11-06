import type { MessageKey } from "@questify/shared";

// The event switches' routes and words, apart from the client components that use them so the template preview
// (`templates.ts`) can read the titles without importing a component.

/** An event switch a player feature has (FR-219, FR-1009): its route and its words. The template preview reads its titles. */
export const FEATURES = {
  shareQuests: {
    path: "share-quests",
    title: "events.shareQuests.title",
    label: "events.shareQuests.label",
  },
  meetSomeone: {
    path: "meet-someone",
    title: "events.meetSomeone.title",
    label: "events.meetSomeone.label",
  },
  miniGames: {
    path: "mini-games",
    title: "events.miniGames.title",
    label: "events.miniGames.label",
  },
  community: {
    path: "community",
    title: "events.community.title",
    label: "events.community.label",
  },
  flashQuests: {
    path: "flash-quests",
    title: "events.flashQuests.title",
    label: "events.flashQuests.label",
  },
  boosts: {
    path: "double-points",
    title: "events.boosts.title",
    label: "events.boosts.label",
  },
  helpDesk: {
    path: "help-desk",
    title: "events.helpDesk.title",
    label: "events.helpDesk.label",
  },
  questRatings: {
    path: "quest-ratings",
    title: "events.questRatings.title",
    label: "events.questRatings.label",
  },
  cheers: {
    path: "cheers",
    title: "events.cheers.title",
    label: "events.cheers.label",
  },
  shop: {
    path: "features/shop",
    title: "events.shop.title",
    label: "events.shop.label",
  },
  polls: {
    path: "features/polls",
    title: "events.polls.title",
    label: "events.polls.label",
  },
  maps: {
    path: "features/maps",
    title: "events.maps.title",
    label: "events.maps.label",
  },
  agenda: {
    path: "features/agenda",
    title: "events.agenda.title",
    label: "events.agenda.label",
  },
} as const satisfies Record<
  string,
  Readonly<{ path: string; title: MessageKey; label: MessageKey }>
>;

/** The two switches: the event's ranking (FR-607) and today's ranking for a multi-day event (FR-608). */
export const SWITCHES = {
  ranking: {
    path: "ranking",
    title: "events.ranking.title",
    label: "events.ranking.label",
    info: "events.ranking.hint",
  },
  rankingToday: {
    path: "ranking-today",
    title: "events.ranking.todayTitle",
    label: "events.ranking.todayLabel",
    info: "events.ranking.todayHint",
  },
} as const;
