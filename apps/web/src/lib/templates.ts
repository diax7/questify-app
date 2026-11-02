import type { MessageKey } from "@questify/shared";

/** The title of each event switch a template may set; the same words the event page's switches carry. */
const SWITCH_TITLES: Readonly<Record<string, MessageKey>> = {
  shareQuests: "events.shareQuests.title",
  meetSomeone: "events.meetSomeone.title",
  miniGames: "events.miniGames.title",
  community: "events.community.title",
  flashQuests: "events.flashQuests.title",
  boosts: "events.boosts.title",
  helpDesk: "events.helpDesk.title",
  questRatings: "events.questRatings.title",
  shop: "events.shop.title",
  polls: "events.polls.title",
  maps: "events.maps.title",
  agenda: "events.agenda.title",
};

/** The switches of a template that have a title to show, in the order the template lists them. */
export function switchesOf(
  features: Readonly<Record<string, boolean>>,
): readonly Readonly<{ title: MessageKey; on: boolean }>[] {
  return Object.entries(features).flatMap(([feature, on]) => {
    const title = SWITCH_TITLES[feature];
    return title === undefined ? [] : [{ title, on }];
  });
}
