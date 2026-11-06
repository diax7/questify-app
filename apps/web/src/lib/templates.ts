import type { MessageKey } from "@questify/shared";
import { FEATURES } from "#src/components/EventFeatureSwitch.tsx";
import { SWITCHES } from "#src/components/RankingSwitch.tsx";

/** The title of each event switch a template may set: the same words the event page's switches carry, read from them. */
const SWITCH_TITLES: Readonly<Record<string, MessageKey>> = Object.fromEntries(
  [...Object.entries(FEATURES), ...Object.entries(SWITCHES)].map(([key, switchOf]) => [
    key,
    switchOf.title,
  ]),
);

/** The switches of a template that have a title to show, in the order the template lists them. */
export function switchesOf(
  features: Readonly<Record<string, boolean>>,
): readonly Readonly<{ title: MessageKey; on: boolean }>[] {
  return Object.entries(features).flatMap(([feature, on]) => {
    const title = SWITCH_TITLES[feature];
    return title === undefined ? [] : [{ title, on }];
  });
}
