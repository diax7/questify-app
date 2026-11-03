import type { MessageKey } from "#src/i18n/messages";
import { isRecord, type ContentIssue } from "#src/layout/content-read";
import { readShown, repairList, type LayoutList } from "#src/layout/layout";

/**
 * The player intro's cards (T-802b, FR-1803): the story cards the app plays on a first launch and from Settings, in the order a
 * platform admin chose, with the ones hidden. It is stored under the platform setting `playerIntro` as `{order, hidden}` and
 * reaches the app inside the configuration as the cards to play, in order (ADR-610). The cards' words are the `onboarding.*`
 * messages of the translation matrix (ADR-593); this is only their order and visibility.
 */

/** The cards, by the name the layout stores. */
export type IntroCardKey = "join" | "quests" | "points" | "prizes";

export type IntroCardDefinition = Readonly<{
  card: IntroCardKey;
  /** The card's title, which the console shows as the row's name. */
  title: MessageKey;
}>;

/**
 * The cards in the order the intro has always played them. The app, the dashboard's editor and the database's door
 * (`player_intro_cards()`, migration 0145) all name these and no others. No card is protected: only the rule that at least one
 * stays shown.
 */
export const PLAYER_INTRO_CARDS: readonly IntroCardDefinition[] = [
  { card: "join", title: "onboarding.card1.title" },
  { card: "quests", title: "onboarding.card2.title" },
  { card: "points", title: "onboarding.card3.title" },
  { card: "prizes", title: "onboarding.card4.title" },
];

export const PLAYER_INTRO_KEYS: readonly IntroCardKey[] = PLAYER_INTRO_CARDS.map(
  (entry) => entry.card,
);

/** What an admin saves and the database stores: every card once in its order, and the hidden ones. */
export type PlayerIntro = LayoutList<IntroCardKey>;

/** What the app receives: the cards to play, in order. */
export type ComposedPlayerIntro = Readonly<{ cards: readonly IntroCardKey[] }>;

/** The intro as it was before it could be edited: every card shown in the shipped order. */
export const DEFAULT_PLAYER_INTRO: PlayerIntro = { order: PLAYER_INTRO_KEYS, hidden: [] };

const NO_CARDS_LEFT = "at least one card must be shown";

/**
 * Reads the intro the platform stored, whatever it holds: a name the app does not know is dropped, a card listed twice counts
 * once, a card that is missing joins the end, and a list that hides every card shows them all. It never throws, so one damaged
 * value plays the shipped intro rather than none.
 */
export function readPlayerIntro(stored: unknown): PlayerIntro {
  const list = repairList(stored, PLAYER_INTRO_KEYS, new Set(), new Set());
  return list.hidden.length >= list.order.length ? { order: list.order, hidden: [] } : list;
}

function nameIssues(raw: unknown, path: "order" | "hidden"): ContentIssue[] {
  if (!Array.isArray(raw)) {
    return [{ path, message: "must be a list" }];
  }
  const issues: ContentIssue[] = [];
  const seen = new Set<unknown>();
  raw.forEach((item: unknown, index) => {
    if (typeof item !== "string" || !PLAYER_INTRO_KEYS.includes(item as IntroCardKey)) {
      issues.push({ path: `${path}.${index}`, message: "is not a card of the intro" });
    } else if (seen.has(item)) {
      issues.push({ path: `${path}.${index}`, message: "is listed twice" });
    }
    seen.add(item);
  });
  return issues;
}

const FIELDS = ["order", "hidden"] as const;

function listIssues(input: Record<string, unknown>): ContentIssue[] {
  const named = [...nameIssues(input["order"], "order"), ...nameIssues(input["hidden"], "hidden")];
  if (named.length > 0) {
    return named;
  }
  const order = input["order"] as readonly string[];
  const hidden = input["hidden"] as readonly string[];
  const missing = PLAYER_INTRO_KEYS.filter((key) => !order.includes(key));
  return [
    ...(missing.length === 0
      ? []
      : [{ path: "order", message: `must list ${missing.join(", ")}` }]),
    ...(hidden.length >= PLAYER_INTRO_KEYS.length
      ? [{ path: "hidden", message: NO_CARDS_LEFT }]
      : []),
  ];
}

/**
 * Checks the intro an admin saves: only `order` and `hidden`, every card exactly once in the order, the hidden ones known and
 * each once, and at least one card left shown. Returns the layout or every problem with its path.
 */
export function checkPlayerIntro(
  input: unknown,
):
  | Readonly<{ ok: true; value: PlayerIntro }>
  | Readonly<{ ok: false; issues: readonly ContentIssue[] }> {
  if (!isRecord(input)) {
    return { ok: false, issues: [{ path: "", message: "must be an object" }] };
  }
  const extra = Object.keys(input).find((key) => !(FIELDS as readonly string[]).includes(key));
  const missing = FIELDS.filter((key) => input[key] === undefined);
  const issues = [
    ...(extra === undefined ? [] : [{ path: extra, message: "is not a part of the intro" }]),
    ...missing.map((key) => ({ path: key, message: "is required" })),
    ...(missing.length === 0 ? listIssues(input) : []),
  ];
  return issues.length > 0
    ? { ok: false, issues }
    : {
        ok: true,
        value: {
          order: input["order"] as readonly IntroCardKey[],
          hidden: input["hidden"] as readonly IntroCardKey[],
        },
      };
}

/** The intro as the app receives it: the cards that are shown, in order. */
export function composedPlayerIntroOf(intro: PlayerIntro): ComposedPlayerIntro {
  return { cards: intro.order.filter((key) => !intro.hidden.includes(key)) };
}

export const DEFAULT_COMPOSED_PLAYER_INTRO: ComposedPlayerIntro =
  composedPlayerIntroOf(DEFAULT_PLAYER_INTRO);

/**
 * Reads the intro of a configuration the app received (or cached). A copy from before the intro could be edited, a value that
 * is not a list, or a list with no card the app knows is the shipped order; names this app does not know are dropped (a newer
 * server never breaks an older app, F-282), so a newer card the app lacks is skipped and the rest play.
 */
export function readComposedPlayerIntro(received: unknown): ComposedPlayerIntro {
  const source = isRecord(received) ? received : {};
  const cards = readShown(source["cards"], PLAYER_INTRO_KEYS, new Set(), []);
  return cards.length === 0 ? DEFAULT_COMPOSED_PLAYER_INTRO : { cards };
}

/** Whether two intros order and show their cards the same way. */
export function samePlayerIntro(a: PlayerIntro, b: PlayerIntro): boolean {
  return (
    a.order.join() === b.order.join() && [...a.hidden].sort().join() === [...b.hidden].sort().join()
  );
}
