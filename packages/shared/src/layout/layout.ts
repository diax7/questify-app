import { PLAYER_TABS, type PlayerTab } from "#src/event/player-view";
import type { MessageKey } from "#src/i18n/messages";
import {
  EMPTY_CONTENT,
  cardKey,
  cardKeysOf,
  readHomeContent,
  sameContent,
  type CardKey,
  type HomeContent,
} from "#src/layout/home-content";

/** The blocks of an event's Home, by the name the layout stores (T-606, FR-1749). */
export type HomeBlock =
  | "banner"
  | "countdown"
  | "standing"
  | "streak"
  | "announcements"
  | "sponsors"
  | "prizes"
  | "live"
  | "goal"
  | "featured"
  | "ranking"
  | "podium"
  | "upNext"
  | "quickLinks"
  | "links";

/** A place in the Home order: one of Questify's blocks, or one of the organizer's cards (`card:<id>`, T-610). */
export type HomeKey = HomeBlock | CardKey;

export type HomeBlockDefinition = Readonly<{
  block: HomeBlock;
  title: MessageKey;
  /** The block is drawn while any of these event switches is on; with none listed it has no switch. */
  features: readonly string[];
  /** Never hidden by a layout: a player's status and points, a prize to collect, and the help and information links. */
  protected: boolean;
  /** Hidden until the organizer shows it, so a block added later never appears on a live event by itself. */
  offByDefault: boolean;
}>;

const block = (
  name: HomeBlock,
  options: Partial<Pick<HomeBlockDefinition, "features" | "protected" | "offByDefault">> = {},
): HomeBlockDefinition => ({
  block: name,
  title: `layout.block.${name}`,
  features: options.features ?? [],
  protected: options.protected ?? false,
  offByDefault: options.offByDefault ?? false,
});

/**
 * Home's blocks in the order Home draws them by default. The player app and the dashboard's preview both read this list, so
 * neither can name a block the other lacks. A block's own conditions (a card with nothing to say) stay inside the block.
 */
export const HOME_BLOCKS: readonly HomeBlockDefinition[] = [
  block("banner"),
  block("countdown"),
  block("standing", { protected: true }),
  block("streak"),
  block("announcements"),
  block("sponsors"),
  block("prizes", { protected: true }),
  block("live", { features: ["community", "cheers"] }),
  block("goal", { features: ["shop"] }),
  block("featured"),
  block("ranking", { features: ["ranking"] }),
  block("podium", { features: ["ranking"], offByDefault: true }),
  block("upNext"),
  block("quickLinks"),
  block("links", { protected: true }),
];

/** A bar never holds more than this many slots (FR-1750). */
export const MAX_BAR_SLOTS = 5;

/**
 * The bar items no layout can hide (FR-1750, ADR-090): Home, the center button (the scanner and My QR) and Profile, which
 * holds Settings, the legal pages and account deletion (STORE_COMPLIANCE 1.10).
 */
export const PROTECTED_TABS: readonly PlayerTab[] = ["index", "scan", "profile"];

/** One list of the layout: every item once in its order, and the ones hidden. */
export type LayoutList<K extends string> = Readonly<{
  order: readonly K[];
  hidden: readonly K[];
}>;

/**
 * What an event stores of its layout (`event.config.layout`): the event bar and Home, each as an order and a hidden set, and
 * what the organizer wrote for the Home blocks that hold content.
 */
export type EventLayout = Readonly<{
  bar: LayoutList<PlayerTab>;
  home: LayoutList<HomeKey>;
  content: HomeContent;
}>;

/** What the app receives: the items to show, in order. The event's switches are applied on top, by `playerTabs`/`homeBlocks`. */
export type ComposedLayout = Readonly<{
  bar: readonly PlayerTab[];
  home: readonly HomeKey[];
  /** The content of the blocks that are shown; a hidden block's draft never reaches a phone. */
  content: HomeContent;
}>;

export const BAR_KEYS: readonly PlayerTab[] = PLAYER_TABS.map((entry) => entry.tab);
export const HOME_KEYS: readonly HomeBlock[] = HOME_BLOCKS.map((entry) => entry.block);
export const BAR_PROTECTED: ReadonlySet<PlayerTab> = new Set(PROTECTED_TABS);
export const HOME_PROTECTED: ReadonlySet<HomeBlock> = new Set(
  HOME_BLOCKS.filter((entry) => entry.protected).map((entry) => entry.block),
);
const HOME_OFF_BY_DEFAULT: ReadonlySet<HomeBlock> = new Set(
  HOME_BLOCKS.filter((entry) => entry.offByDefault).map((entry) => entry.block),
);

/** Every name the Home order of an event with this content may hold: Questify's blocks, then its cards. */
export const homeKeysOf = (content: HomeContent): readonly HomeKey[] => [
  ...HOME_KEYS,
  ...cardKeysOf(content),
];

/** Questify's own layout: every block shown in the order the app has always used, except those that start off. */
export const DEFAULT_LAYOUT: EventLayout = {
  bar: { order: BAR_KEYS, hidden: [] },
  home: { order: HOME_KEYS, hidden: HOME_KEYS.filter((key) => HOME_OFF_BY_DEFAULT.has(key)) },
  content: EMPTY_CONTENT,
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The known items of a stored array, each once, in the stored order. */
function knownOnce<K extends string>(stored: unknown, keys: readonly K[]): K[] {
  if (!Array.isArray(stored)) {
    return [];
  }
  const seen = new Set<K>();
  for (const item of stored) {
    const key = keys.find((candidate) => candidate === item);
    if (key !== undefined) {
      seen.add(key);
    }
  }
  return [...seen];
}

function repairList<K extends string>(
  stored: unknown,
  keys: readonly K[],
  protectedKeys: ReadonlySet<string>,
  offByDefault: ReadonlySet<string>,
): LayoutList<K> {
  const source = isRecord(stored) ? stored : {};
  const listed = knownOnce(source["order"], keys);
  // An item a newer app added is missing from an older save: it joins at the end rather than voiding the layout, and stays
  // hidden when it starts off (a block added later never appears on a live event by itself).
  const added = keys.filter((key) => !listed.includes(key));
  const hidden = [
    ...knownOnce(source["hidden"], keys).filter((key) => !protectedKeys.has(key)),
    ...added.filter((key) => offByDefault.has(key)),
  ];
  return { order: [...listed, ...added], hidden };
}

/**
 * Reads the layout an event stored, whatever it holds: items the app does not know are dropped, an item listed twice counts
 * once, a missing item joins at the end and a protected item is never hidden. It never throws and never returns a layout
 * that hides a protected item, so one damaged value can never take the scanner or Settings off a player's screen.
 */
export function readEventLayout(stored: unknown): EventLayout {
  const source = isRecord(stored) ? stored : {};
  const content = readHomeContent(source["content"]);
  return {
    bar: repairList(source["bar"], BAR_KEYS, BAR_PROTECTED, new Set()),
    home: repairList(source["home"], homeKeysOf(content), HOME_PROTECTED, HOME_OFF_BY_DEFAULT),
    content,
  };
}

const shownOf = <K extends string>(list: LayoutList<K>): K[] =>
  list.order.filter((key) => !list.hidden.includes(key));

/** The content of the blocks that are shown: a hidden block's text is a draft and stays on the server. */
function shownContent(content: HomeContent, home: readonly HomeKey[]): HomeContent {
  return {
    banner: home.includes("banner") ? content.banner : [],
    quickLinks: home.includes("quickLinks") ? content.quickLinks : [],
    featured: home.includes("featured") ? content.featured : null,
    cards: content.cards.filter((card) => home.includes(cardKey(card.id))),
  };
}

/** The layout as the app receives it: only what is shown, in order, with the content of what is shown. */
export function composedLayoutOf(layout: EventLayout): ComposedLayout {
  const home = shownOf(layout.home);
  return { bar: shownOf(layout.bar), home, content: shownContent(layout.content, home) };
}

export const DEFAULT_COMPOSED_LAYOUT: ComposedLayout = composedLayoutOf(DEFAULT_LAYOUT);

/** The list a received copy holds, or the default when it names no list or leaves out a protected item. */
function readShown<K extends string>(
  received: unknown,
  keys: readonly K[],
  protectedKeys: ReadonlySet<string>,
  fallback: readonly K[],
): readonly K[] {
  const shown = knownOnce(received, keys);
  return [...protectedKeys].every((key) => shown.some((item) => item === key)) ? shown : fallback;
}

/**
 * Reads the layout of a configuration the app received (or cached). A copy from before layouts existed, a list that is not
 * a list, or one that leaves out Home, the scan button, Profile or a protected block falls back to Questify's own layout for
 * that list; names this app does not know are dropped (a newer server never breaks an older app, F-282).
 */
export function readComposedLayout(received: unknown): ComposedLayout {
  const source = isRecord(received) ? received : {};
  const content = readHomeContent(source["content"]);
  return {
    bar: readShown(source["bar"], BAR_KEYS, BAR_PROTECTED, DEFAULT_COMPOSED_LAYOUT.bar).slice(
      0,
      MAX_BAR_SLOTS,
    ),
    home: readShown(
      source["home"],
      homeKeysOf(content),
      HOME_PROTECTED,
      DEFAULT_COMPOSED_LAYOUT.home,
    ),
    content,
  };
}

/**
 * The Home blocks a player sees, in the layout's order: a block whose event switches are all off stays hidden whatever the
 * layout says (a layout never turns a feature back on, FR-1009). The app's Home and the dashboard's preview both read this.
 */
export function homeBlocks(
  featureOn: (feature: string) => boolean,
  shown: readonly HomeKey[] = DEFAULT_COMPOSED_LAYOUT.home,
): readonly HomeKey[] {
  return shown.filter((key) => {
    const features = HOME_BLOCKS.find((entry) => entry.block === key)?.features ?? [];
    return features.length === 0 || features.some(featureOn);
  });
}

/**
 * The order the event's tab screens are registered in: the shown tabs in the layout's order, then the rest, which stay
 * registered but have no bar item (a hidden tab's screen is still a route).
 */
export function barScreenOrder(shown: readonly PlayerTab[]): readonly PlayerTab[] {
  return [...shown, ...BAR_KEYS.filter((tab) => !shown.includes(tab))];
}

const sameList = <K extends string>(x: LayoutList<K>, y: LayoutList<K>): boolean =>
  x.order.join() === y.order.join() && [...x.hidden].sort().join() === [...y.hidden].sort().join();

/** Whether two layouts show and order everything the same way and say the same words. */
export function sameLayout(a: EventLayout, b: EventLayout): boolean {
  return sameList(a.bar, b.bar) && sameList(a.home, b.home) && sameContent(a.content, b.content);
}
