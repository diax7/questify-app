import type { PlayerTab } from "#src/event/player-view";
import type { MessageKey } from "#src/i18n/messages";
import {
  BAR_KEYS,
  DEFAULT_LAYOUT,
  HOME_KEYS,
  sameLayout,
  type EventLayout,
  type HomeBlock,
} from "#src/layout/layout";

export type LayoutPreset = Readonly<{ id: string; title: MessageKey; layout: EventLayout }>;

const first = <K extends string>(keys: readonly K[], ...front: readonly K[]): readonly K[] => [
  ...front,
  ...keys.filter((key) => !front.includes(key)),
];

const arranged = (
  bar: Readonly<{ front?: readonly PlayerTab[]; hidden?: readonly PlayerTab[] }>,
  home: Readonly<{ front?: readonly HomeBlock[]; hidden?: readonly HomeBlock[] }>,
): EventLayout => ({
  bar: { order: first(BAR_KEYS, ...(bar.front ?? [])), hidden: bar.hidden ?? [] },
  home: { order: first(HOME_KEYS, ...(home.front ?? [])), hidden: home.hidden ?? [] },
});

/**
 * The layouts the Questify team approves for an event (FR-1764, ADR-090). They are data in the reviewed code: the team adds or
 * retires one by shipping the list. An event stores the layout itself, never the preset's name, so a retired preset leaves
 * every event that used it exactly as it was until its organizer picks another.
 */
export const LAYOUT_PRESETS: readonly LayoutPreset[] = [
  { id: "classic", title: "layout.preset.classic", layout: DEFAULT_LAYOUT },
  {
    id: "play_first",
    title: "layout.preset.playFirst",
    layout: arranged({}, { front: ["standing", "upNext", "ranking"] }),
  },
  {
    id: "prizes_first",
    title: "layout.preset.prizesFirst",
    layout: arranged(
      { front: ["index", "rewards", "scan"] },
      { front: ["standing", "goal", "prizes", "upNext"] },
    ),
  },
  {
    id: "essentials",
    title: "layout.preset.essentials",
    layout: arranged({ hidden: ["rewards"] }, { hidden: ["streak", "sponsors", "live"] }),
  },
];

export function presetLayout(id: string): EventLayout | undefined {
  return LAYOUT_PRESETS.find((preset) => preset.id === id)?.layout;
}

/** The preset a layout matches exactly, or null for a layout that is the organizer's own. */
export function matchingPreset(layout: EventLayout): LayoutPreset | null {
  return LAYOUT_PRESETS.find((preset) => sameLayout(preset.layout, layout)) ?? null;
}
