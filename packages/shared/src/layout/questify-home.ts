import type { MessageKey } from "#src/i18n/messages";
import {
  fail,
  isRecord,
  readList,
  type ContentIssue,
  type Mode,
  type Read,
} from "#src/layout/content-read";
import {
  BANNER_SLIDES_MAX,
  readSlide,
  sameBanner,
  type BannerSlide,
} from "#src/layout/home-content";
import { readShown, repairList } from "#src/layout/layout";

/**
 * Questify home's layout (T-713, FR-1838): the blocks the app draws outside an event, in the order a platform admin chose, the
 * ones hidden, and the text slides of the banner. It is stored under the platform setting `questifyHome` as
 * `{order, hidden, banner}` and reaches the app inside the configuration as the blocks to show and the banner (ADR-510).
 */

/** The blocks of Questify home, by the name the layout stores. */
export type QuestifyHomeBlock =
  | "banner"
  | "notices"
  | "code"
  | "account"
  | "operator"
  | "invitations"
  | "streak"
  | "dailyChallenge"
  | "dailyWord"
  | "events"
  | "quests";

export type QuestifyHomeBlockDefinition = Readonly<{
  block: QuestifyHomeBlock;
  title: MessageKey;
  /**
   * Never hidden by a layout: what Questify says about a switched-off feature, the typed code for anyone who cannot scan, the
   * recovery email, the staff's way to their event, invitations and the player's own events (ADR-511). It can still move.
   */
  protected: boolean;
}>;

const block = (name: QuestifyHomeBlock, isProtected: boolean): QuestifyHomeBlockDefinition => ({
  block: name,
  title: `questifyHome.block.${name}`,
  protected: isProtected,
});

/**
 * Questify home's blocks in the order the app draws them by default. The app, the dashboard's editor and the database's door
 * (`questify_home_blocks()`, migration 0137) all name these and no others. A block keeps its own conditions: a streak the
 * platform switched off, or a game with no content today, draws nothing whatever the layout says.
 */
export const QUESTIFY_HOME_BLOCKS: readonly QuestifyHomeBlockDefinition[] = [
  block("banner", false),
  block("notices", true),
  block("code", true),
  block("account", true),
  block("operator", true),
  block("invitations", true),
  block("streak", false),
  block("dailyChallenge", false),
  block("dailyWord", false),
  block("events", true),
  block("quests", false),
];

export const QUESTIFY_HOME_KEYS: readonly QuestifyHomeBlock[] = QUESTIFY_HOME_BLOCKS.map(
  (entry) => entry.block,
);
export const QUESTIFY_HOME_PROTECTED: ReadonlySet<QuestifyHomeBlock> = new Set(
  QUESTIFY_HOME_BLOCKS.filter((entry) => entry.protected).map((entry) => entry.block),
);

/** What an admin saves and the database stores: every block once in its order, the hidden ones, the banner's slides. */
export type QuestifyHome = Readonly<{
  order: readonly QuestifyHomeBlock[];
  hidden: readonly QuestifyHomeBlock[];
  banner: readonly BannerSlide[];
}>;

/** What the app receives: the blocks to draw in order, and the banner's slides (none while the banner block is hidden). */
export type ComposedQuestifyHome = Readonly<{
  blocks: readonly QuestifyHomeBlock[];
  banner: readonly BannerSlide[];
}>;

/** The screen as it was before the layout could be edited: every block shown in the default order, no slides. */
export const DEFAULT_QUESTIFY_HOME: QuestifyHome = {
  order: QUESTIFY_HOME_KEYS,
  hidden: [],
  banner: [],
};

/** A tap on a Questify home slide opens nothing or a web page; the other taps open an event's screens (ADR-512). */
const HOME_TAPS: ReadonlySet<string> = new Set(["none", "link"]);

function readHomeSlide(raw: unknown, path: string, mode: Mode): Read<BannerSlide> {
  const slide = readSlide(raw, path, mode);
  return !slide.ok || HOME_TAPS.has(slide.value.action.type)
    ? slide
    : fail(`${path}.action`, "must open nothing or a web link");
}

const readSlides = (raw: unknown, mode: Mode) =>
  readList(raw, "banner", BANNER_SLIDES_MAX, (item, path) => readHomeSlide(item, path, mode));

/**
 * Reads the layout the platform stored, whatever it holds: a name the app does not know is dropped, a block listed twice counts
 * once, a block that is missing joins the end, a protected block is never hidden and a slide that is not valid is left out. It
 * never throws, so one damaged value shows the default rather than breaking Home.
 */
export function readQuestifyHome(stored: unknown): QuestifyHome {
  const source = isRecord(stored) ? stored : {};
  const list = repairList(source, QUESTIFY_HOME_KEYS, QUESTIFY_HOME_PROTECTED, new Set());
  return {
    order: list.order,
    hidden: list.hidden,
    banner: readSlides(source["banner"], { strict: false }).values,
  };
}

const FIELDS = ["order", "hidden", "banner"] as const;

function nameIssues(
  raw: unknown,
  path: "order" | "hidden",
  known: readonly string[],
): ContentIssue[] {
  if (!Array.isArray(raw)) {
    return [{ path, message: "must be a list" }];
  }
  const issues: ContentIssue[] = [];
  const seen = new Set<unknown>();
  raw.forEach((item: unknown, index) => {
    if (typeof item !== "string" || !known.includes(item)) {
      issues.push({ path: `${path}.${index}`, message: "is not a block of Questify home" });
    } else if (seen.has(item)) {
      issues.push({ path: `${path}.${index}`, message: "is listed twice" });
    }
    seen.add(item);
  });
  return issues;
}

function listIssues(input: Record<string, unknown>): ContentIssue[] {
  const order = nameIssues(input["order"], "order", QUESTIFY_HOME_KEYS);
  const hidden = nameIssues(input["hidden"], "hidden", QUESTIFY_HOME_KEYS);
  if (order.length > 0 || hidden.length > 0) {
    return [...order, ...hidden];
  }
  const listed = input["order"] as readonly string[];
  const missing = QUESTIFY_HOME_KEYS.filter((key) => !listed.includes(key));
  const locked = (input["hidden"] as readonly string[]).filter((key) =>
    QUESTIFY_HOME_PROTECTED.has(key as QuestifyHomeBlock),
  );
  return [
    ...(missing.length === 0
      ? []
      : [{ path: "order", message: `must list ${missing.join(", ")}` }]),
    ...locked.map((key) => ({ path: "hidden", message: `${key} cannot be hidden` })),
  ];
}

/**
 * Checks the layout an admin saves: every block exactly once, none of the protected ones hidden, at most five slides, each
 * with cleaned and bounded text and a tap that opens nothing or an https link. Returns the cleaned layout or every problem
 * with its path.
 */
export function checkQuestifyHome(
  input: unknown,
):
  | Readonly<{ ok: true; value: QuestifyHome }>
  | Readonly<{ ok: false; issues: readonly ContentIssue[] }> {
  if (!isRecord(input)) {
    return { ok: false, issues: [{ path: "", message: "must be an object" }] };
  }
  const extra = Object.keys(input).find((key) => !(FIELDS as readonly string[]).includes(key));
  const missing = FIELDS.filter((key) => input[key] === undefined);
  const slides = readSlides(input["banner"], { strict: true });
  const issues = [
    ...(extra === undefined ? [] : [{ path: extra, message: "is not a part of Questify home" }]),
    ...missing.map((key) => ({ path: key, message: "is required" })),
    ...(missing.length === 0 ? listIssues(input) : []),
    ...(input["banner"] === undefined ? [] : slides.issues),
  ];
  return issues.length > 0
    ? { ok: false, issues }
    : {
        ok: true,
        value: {
          order: input["order"] as readonly QuestifyHomeBlock[],
          hidden: input["hidden"] as readonly QuestifyHomeBlock[],
          banner: slides.values,
        },
      };
}

/** The layout as the app receives it: the blocks that are shown, in order, and the banner while its block is shown. */
export function composedQuestifyHomeOf(home: QuestifyHome): ComposedQuestifyHome {
  const blocks = home.order.filter((key) => !home.hidden.includes(key));
  return { blocks, banner: blocks.includes("banner") ? home.banner : [] };
}

export const DEFAULT_COMPOSED_QUESTIFY_HOME: ComposedQuestifyHome =
  composedQuestifyHomeOf(DEFAULT_QUESTIFY_HOME);

/**
 * Reads the layout of a configuration the app received (or cached). A copy from before the layout existed, a list that is
 * not a list, or one that leaves out a protected block is the default order; names this app does not know are dropped (a
 * newer server never breaks an older app, F-282); a slide that is not valid is left out.
 */
export function readComposedQuestifyHome(received: unknown): ComposedQuestifyHome {
  const source = isRecord(received) ? received : {};
  return {
    blocks: readShown(
      source["blocks"],
      QUESTIFY_HOME_KEYS,
      QUESTIFY_HOME_PROTECTED,
      DEFAULT_COMPOSED_QUESTIFY_HOME.blocks,
    ),
    banner: readSlides(source["banner"], { strict: false }).values,
  };
}

const sameNames = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && [...a].sort().join() === [...b].sort().join();

/** Whether two layouts order, show and say everything the same way. */
export function sameQuestifyHome(a: QuestifyHome, b: QuestifyHome): boolean {
  return (
    a.order.join() === b.order.join() &&
    sameNames(a.hidden, b.hidden) &&
    sameBanner(a.banner, b.banner)
  );
}
