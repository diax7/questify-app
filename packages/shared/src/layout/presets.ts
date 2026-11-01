import type { PlayerTab } from "#src/event/player-view";
import type { MessageKey } from "#src/i18n/messages";
import { isCardKey } from "#src/layout/home-content";
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
  home: {
    order: first(HOME_KEYS, ...(home.front ?? [])),
    // Blocks that start off stay off in every preset, unless the preset lists them itself.
    hidden: [...new Set([...DEFAULT_LAYOUT.home.hidden, ...(home.hidden ?? [])])],
  },
  info: DEFAULT_LAYOUT.info,
  content: DEFAULT_LAYOUT.content,
  looks: DEFAULT_LAYOUT.looks,
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

/**
 * A preset laid over an event's layout (FR-1831): the bar and Questify's blocks take the preset's order and switches, and the
 * organizer's cards and all that was written stay as they were, after the blocks, in their own order and shown or hidden as
 * they were. A preset never deletes a word the organizer wrote, and never changes how the screens are drawn (T-611).
 */
export function applyPreset(current: EventLayout, preset: EventLayout): EventLayout {
  return {
    bar: preset.bar,
    home: {
      order: [...preset.home.order, ...current.home.order.filter(isCardKey)],
      hidden: [...preset.home.hidden, ...current.home.hidden.filter(isCardKey)],
    },
    info: current.info,
    content: current.content,
    looks: current.looks,
  };
}

/** The preset a layout matches exactly (its cards and words aside), or null for a layout that is the organizer's own. */
export function matchingPreset(layout: EventLayout): LayoutPreset | null {
  return (
    LAYOUT_PRESETS.find((preset) => sameLayout(applyPreset(layout, preset.layout), layout)) ?? null
  );
}
