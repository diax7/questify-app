import { cleanAnnouncementText } from "#src/announcements/announcements";

/**
 * What an organizer writes into the event's Home (T-610, FR-1828 to FR-1830): banner slides, quick links, a featured quest or
 * reward, and text and countdown cards. It is stored in `event.config.layout.content` next to the arrangement (ADR-391,
 * ADR-395). Every text is plain: the app and the dashboard draw it as text, never as HTML or Markdown, and nothing in it is
 * tappable except a link the organizer chose from the allowed kinds.
 */

export const BANNER_SLIDES_MAX = 5;
export const QUICK_LINKS_MAX = 6;
/** Text cards and countdown cards together. */
export const HOME_CARDS_MAX = 6;
export const LINK_URL_MAX = 300;

/** Longest text per field, in code points. */
export const CONTENT_LIMITS = {
  slideTitle: 60,
  slideSubtitle: 100,
  linkLabel: 24,
  cardTitle: 60,
  cardBody: 400,
  countdownLabel: 60,
  countdownMessage: 120,
} as const;

/** The icons a quick link can wear (Questify's own set; each client draws its own picture for the name). */
export const QUICK_LINK_ICONS = [
  "calendar",
  "map",
  "gift",
  "trophy",
  "star",
  "compass",
  "bolt",
  "info",
] as const;
export type QuickLinkIcon = (typeof QUICK_LINK_ICONS)[number];

/** Words an organizer wrote in each language; an empty string is a language left out. */
export type LocalText = Readonly<{ ar: string; en: string }>;

/**
 * What a tap does. Only places inside the app and https links: `agenda`, `maps` and `shop` open those screens (and do nothing
 * while their event switch is off), `quest` opens one quest, `link` opens a web page after the player agrees.
 */
export type TapAction =
  | Readonly<{ type: "none" }>
  | Readonly<{ type: "agenda" }>
  | Readonly<{ type: "maps" }>
  | Readonly<{ type: "shop" }>
  | Readonly<{ type: "quest"; questId: string }>
  | Readonly<{ type: "link"; url: string }>;

export type BannerSlide = Readonly<{ title: LocalText; subtitle: LocalText; action: TapAction }>;
export type QuickLink = Readonly<{ label: LocalText; icon: QuickLinkIcon; action: TapAction }>;
export type FeaturedTarget = Readonly<{ kind: "quest" | "reward"; id: string }>;

export type TextCard = Readonly<{ id: string; kind: "text"; title: LocalText; body: LocalText }>;
export type CountdownCard = Readonly<{
  id: string;
  kind: "countdown";
  label: LocalText;
  /** The moment the count ends, as a UTC ISO time. */
  at: string;
  atZero: "hide" | "message";
  message: LocalText;
}>;
export type HomeCard = TextCard | CountdownCard;

export type HomeContent = Readonly<{
  banner: readonly BannerSlide[];
  quickLinks: readonly QuickLink[];
  featured: FeaturedTarget | null;
  cards: readonly HomeCard[];
}>;

export const EMPTY_CONTENT: HomeContent = { banner: [], quickLinks: [], featured: null, cards: [] };

/** A card's place in the Home order. */
export type CardKey = `card:${string}`;
export const cardKey = (id: string): CardKey => `card:${id}`;
export const isCardKey = (key: string): key is CardKey => key.startsWith("card:");

export type ContentIssue = Readonly<{ path: string; message: string }>;
type Read<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; path: string; message: string }>;
/** `strict` is the organizer's save: texts are cleaned first and a field this block does not have is refused. */
type Mode = Readonly<{ strict: boolean }>;

const ok = <T>(value: T): Read<T> => ({ ok: true, value });
const fail = (path: string, message: string): Read<never> => ({ ok: false, path, message });
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const points = (text: string): number => Array.from(text).length;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CARD_ID = /^[a-z0-9]{6,12}$/;
/** `https`, a full host name (no address, no user info), an optional port, then a path, query or fragment without spaces. */
const LINK =
  /^https:\/\/(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(?::\d{1,5})?(?:[/?#][^\s\\]*)?$/i;
const INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

/** Whether a link may be tapped from Home: https only, to a named host (T-610). */
export const isAllowedLink = (url: string): boolean =>
  url.length <= LINK_URL_MAX && LINK.test(url) && !hasControlCharacter(url);

function hasControlCharacter(text: string): boolean {
  return Array.from(text).some((char) => {
    const code = char.codePointAt(0) ?? 0;
    return code < 32 || (code >= 127 && code < 160);
  });
}

/** The host of an allowed link, for the question asked before it opens. */
export function linkHost(url: string): string {
  return /^https:\/\/([^/?#:]+)/i.exec(url)?.[1]?.toLowerCase() ?? "";
}

/**
 * The text as it is stored: invisible and control characters removed, whitespace made one space, Arabic-Indic digits made
 * Western (ADR-018); a card's body keeps its line breaks, at most one blank line in a row. Uses unicode property classes, so
 * only the server calls it (the app reads what was stored).
 */
export function cleanBlockText(raw: string, multiline: boolean): string {
  if (!multiline) {
    return cleanAnnouncementText(raw);
  }
  const lines = raw.split(/\r\n|\r|\n/u).map(cleanAnnouncementText);
  const kept = lines.filter((line, index) => line !== "" || (lines[index - 1] ?? "") !== "");
  return kept.join("\n").trim();
}

function readText(
  raw: unknown,
  path: string,
  max: number,
  mode: Mode,
  multiline = false,
): Read<string> {
  if (typeof raw !== "string") {
    return fail(path, "must be text");
  }
  const text = mode.strict ? cleanBlockText(raw, multiline) : raw;
  return points(text) > max ? fail(path, `is longer than ${max} characters`) : ok(text);
}

const NEEDS_LANGUAGE = "needs text in Arabic or English";

const blank = (a: string, b: string): boolean => a === "" && b === "";
const languageOf = (value: Record<string, unknown>, lang: "ar" | "en"): unknown =>
  value[lang] ?? "";

function readLocal(
  raw: unknown,
  path: string,
  max: number,
  mode: Mode,
  options: Readonly<{ required: boolean; multiline?: boolean }>,
): Read<LocalText> {
  const found = readKeys(raw, path, ["ar", "en"], mode);
  if (!found.ok) return found;
  const ar = readText(languageOf(found.value, "ar"), `${path}.ar`, max, mode, options.multiline);
  const en = readText(languageOf(found.value, "en"), `${path}.en`, max, mode, options.multiline);
  if (!ar.ok) return ar;
  if (!en.ok) return en;
  return options.required && blank(ar.value, en.value)
    ? fail(path, NEEDS_LANGUAGE)
    : ok({ ar: ar.value, en: en.value });
}

function readKeys(
  raw: unknown,
  path: string,
  known: readonly string[],
  mode: Mode,
): Read<Record<string, unknown>> {
  if (!isRecord(raw)) {
    return fail(path, "must be an object");
  }
  const extra = mode.strict ? Object.keys(raw).find((key) => !known.includes(key)) : undefined;
  return extra === undefined ? ok(raw) : fail(`${path}.${extra}`, "is not a field of this block");
}

function readQuestAction(found: Record<string, unknown>, path: string): Read<TapAction> {
  const { questId } = found;
  return typeof questId === "string" && UUID.test(questId)
    ? ok({ type: "quest", questId: questId.toLowerCase() })
    : fail(`${path}.questId`, "must be a quest of the event");
}

function readLinkAction(found: Record<string, unknown>, path: string): Read<TapAction> {
  const link = typeof found["url"] === "string" ? found["url"].trim() : "";
  return isAllowedLink(link)
    ? ok({ type: "link", url: link })
    : fail(`${path}.url`, "must be a full https link");
}

function readAction(raw: unknown, path: string, mode: Mode): Read<TapAction> {
  const found = readKeys(raw, path, ["type", "questId", "url"], mode);
  if (!found.ok) return found;
  const { type } = found.value;
  if (type === "none" || type === "agenda" || type === "maps" || type === "shop") {
    return ok({ type });
  }
  if (type === "quest") return readQuestAction(found.value, path);
  return type === "link"
    ? readLinkAction(found.value, path)
    : fail(`${path}.type`, "is not a kind of tap");
}

function readSlide(raw: unknown, path: string, mode: Mode): Read<BannerSlide> {
  const found = readKeys(raw, path, ["title", "subtitle", "action"], mode);
  if (!found.ok) return found;
  const title = readLocal(found.value["title"], `${path}.title`, CONTENT_LIMITS.slideTitle, mode, {
    required: true,
  });
  const subtitle = readLocal(
    found.value["subtitle"] ?? { ar: "", en: "" },
    `${path}.subtitle`,
    CONTENT_LIMITS.slideSubtitle,
    mode,
    { required: false },
  );
  const action = readAction(found.value["action"] ?? { type: "none" }, `${path}.action`, mode);
  if (!title.ok) return title;
  if (!subtitle.ok) return subtitle;
  return action.ok
    ? ok({ title: title.value, subtitle: subtitle.value, action: action.value })
    : action;
}

function readQuickLink(raw: unknown, path: string, mode: Mode): Read<QuickLink> {
  const found = readKeys(raw, path, ["label", "icon", "action"], mode);
  if (!found.ok) return found;
  const label = readLocal(found.value["label"], `${path}.label`, CONTENT_LIMITS.linkLabel, mode, {
    required: true,
  });
  const icon = QUICK_LINK_ICONS.find((name) => name === found.value["icon"]);
  const action = readAction(found.value["action"], `${path}.action`, mode);
  if (!label.ok) return label;
  if (icon === undefined) return fail(`${path}.icon`, "is not an icon of the app");
  if (!action.ok) return action;
  return action.value.type === "none"
    ? fail(`${path}.action`, "must open something")
    : ok({ label: label.value, icon, action: action.value });
}

function readFeatured(raw: unknown, path: string, mode: Mode): Read<FeaturedTarget | null> {
  if (raw === null || raw === undefined) {
    return ok(null);
  }
  const found = readKeys(raw, path, ["kind", "id"], mode);
  if (!found.ok) return found;
  const { kind, id } = found.value;
  if (kind !== "quest" && kind !== "reward") {
    return fail(`${path}.kind`, "must be a quest or a reward");
  }
  return typeof id === "string" && UUID.test(id)
    ? ok({ kind, id: id.toLowerCase() })
    : fail(`${path}.id`, "must be a quest or reward of the event");
}

/** Whether the date a text names exists (30 February would roll over to March when parsed). */
function realDate(parts: RegExpExecArray): boolean {
  const [year, month, day] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
}

function readInstant(raw: unknown, path: string): Read<string> {
  const parts = typeof raw === "string" ? INSTANT.exec(raw) : null;
  const time = parts !== null && realDate(parts) ? Date.parse(String(raw)) : Number.NaN;
  const year = Number.isNaN(time) ? 0 : new Date(time).getUTCFullYear();
  return year >= 2000 && year <= 2100
    ? ok(new Date(time).toISOString())
    : fail(path, "must be a date and time");
}

function readCountdown(
  found: Record<string, unknown>,
  id: string,
  path: string,
  mode: Mode,
): Read<CountdownCard> {
  const label = readLocal(found["label"], `${path}.label`, CONTENT_LIMITS.countdownLabel, mode, {
    required: true,
  });
  const at = readInstant(found["at"], `${path}.at`);
  const atZero =
    found["atZero"] === "hide" || found["atZero"] === "message" ? found["atZero"] : null;
  const message = readLocal(
    found["message"] ?? { ar: "", en: "" },
    `${path}.message`,
    CONTENT_LIMITS.countdownMessage,
    mode,
    { required: atZero === "message" },
  );
  if (!label.ok) return label;
  if (!at.ok) return at;
  if (atZero === null) return fail(`${path}.atZero`, "must be hide or message");
  if (!message.ok) return message;
  return ok({
    id,
    kind: "countdown",
    label: label.value,
    at: at.value,
    atZero,
    message: message.value,
  });
}

const TEXT_CARD_KEYS = ["id", "kind", "title", "body"];
const COUNTDOWN_CARD_KEYS = ["id", "kind", "label", "at", "atZero", "message"];

function readTextCard(
  found: Record<string, unknown>,
  id: string,
  path: string,
  mode: Mode,
): Read<HomeCard> {
  const title = readLocal(
    found["title"] ?? { ar: "", en: "" },
    `${path}.title`,
    CONTENT_LIMITS.cardTitle,
    mode,
    { required: false },
  );
  const body = readLocal(found["body"], `${path}.body`, CONTENT_LIMITS.cardBody, mode, {
    required: true,
    multiline: true,
  });
  if (!title.ok) return title;
  return body.ok ? ok({ id, kind: "text", title: title.value, body: body.value }) : body;
}

function kindOf(raw: unknown): HomeCard["kind"] | null {
  const kind = isRecord(raw) ? raw["kind"] : undefined;
  return kind === "text" || kind === "countdown" ? kind : null;
}

function readCard(raw: unknown, path: string, mode: Mode): Read<HomeCard> {
  const kind = kindOf(raw);
  if (kind === null) {
    return fail(`${path}.kind`, "must be text or countdown");
  }
  const found = readKeys(raw, path, kind === "text" ? TEXT_CARD_KEYS : COUNTDOWN_CARD_KEYS, mode);
  if (!found.ok) return found;
  const id = found.value["id"];
  if (typeof id !== "string" || !CARD_ID.test(id)) {
    return fail(`${path}.id`, "must be 6 to 12 lowercase letters or digits");
  }
  return kind === "countdown"
    ? readCountdown(found.value, id, path, mode)
    : readTextCard(found.value, id, path, mode);
}

type ListRead<T> = Readonly<{ values: T[]; issues: ContentIssue[] }>;

function readList<T>(
  raw: unknown,
  path: string,
  max: number,
  readOne: (item: unknown, itemPath: string) => Read<T>,
): ListRead<T> {
  if (!Array.isArray(raw)) {
    return { values: [], issues: raw === undefined ? [] : [{ path, message: "must be a list" }] };
  }
  const values: T[] = [];
  const issues: ContentIssue[] = [];
  if (raw.length > max) {
    issues.push({ path, message: `has more than ${max} items` });
  }
  raw.slice(0, max).forEach((item: unknown, index) => {
    const read = readOne(item, `${path}.${index}`);
    if (read.ok) {
      values.push(read.value);
    } else {
      issues.push({ path: read.path, message: read.message });
    }
  });
  return { values, issues };
}

function readCards(raw: unknown, path: string, mode: Mode): ListRead<HomeCard> {
  const list = readList(raw, path, HOME_CARDS_MAX, (item, itemPath) =>
    readCard(item, itemPath, mode),
  );
  const seen = new Set<string>();
  const values = list.values.filter((card) => {
    const fresh = !seen.has(card.id);
    seen.add(card.id);
    return fresh;
  });
  const issues =
    values.length === list.values.length
      ? list.issues
      : [...list.issues, { path, message: "lists a card twice" }];
  return { values, issues };
}

const CONTENT_KEYS = ["banner", "quickLinks", "featured", "cards"] as const;

function readContent(
  raw: unknown,
  mode: Mode,
): Readonly<{ content: HomeContent; issues: ContentIssue[] }> {
  const source = isRecord(raw) ? raw : {};
  const extra = mode.strict
    ? Object.keys(source).find((key) => !(CONTENT_KEYS as readonly string[]).includes(key))
    : undefined;
  const banner = readList(source["banner"], "content.banner", BANNER_SLIDES_MAX, (item, path) =>
    readSlide(item, path, mode),
  );
  const links = readList(
    source["quickLinks"],
    "content.quickLinks",
    QUICK_LINKS_MAX,
    (item, path) => readQuickLink(item, path, mode),
  );
  const featured = readFeatured(source["featured"], "content.featured", mode);
  const cards = readCards(source["cards"], "content.cards", mode);
  const issues = [
    ...(extra === undefined
      ? []
      : [{ path: `content.${extra}`, message: "is not a part of Home" }]),
    ...(isRecord(raw) || raw === undefined
      ? []
      : [{ path: "content", message: "must be an object" }]),
    ...banner.issues,
    ...links.issues,
    ...(featured.ok ? [] : [{ path: featured.path, message: featured.message }]),
    ...cards.issues,
  ];
  const content: HomeContent = {
    banner: banner.values,
    quickLinks: links.values,
    featured: featured.ok ? featured.value : null,
    cards: cards.values,
  };
  return { content, issues };
}

/**
 * Reads the content an event stored, whatever it holds: an item that is not valid is left out, a list is cut to its limit,
 * and it never throws. The player app and the API both read with it, so a damaged value shows less rather than breaking Home.
 */
export function readHomeContent(stored: unknown): HomeContent {
  return readContent(stored, { strict: false }).content;
}

/**
 * Checks the content an organizer saves: texts are cleaned (invisible characters removed, Western digits), every item must be
 * valid and within its limit, and a field the block does not have is refused. Returns the cleaned content or every problem
 * with its path.
 */
export function checkHomeContent(
  input: unknown,
):
  | Readonly<{ ok: true; value: HomeContent }>
  | Readonly<{ ok: false; issues: readonly ContentIssue[] }> {
  if (!isRecord(input)) {
    return { ok: false, issues: [{ path: "content", message: "must be an object" }] };
  }
  const missing = CONTENT_KEYS.filter((key) => input[key] === undefined);
  if (missing.length > 0) {
    return {
      ok: false,
      issues: missing.map((key) => ({ path: `content.${key}`, message: "is required" })),
    };
  }
  const { content, issues } = readContent(input, { strict: true });
  return issues.length > 0 ? { ok: false, issues } : { ok: true, value: content };
}

/** The Home-order keys of the cards in this content. */
export const cardKeysOf = (content: HomeContent): CardKey[] =>
  content.cards.map((card) => cardKey(card.id));

/** Whether two contents say the same, whatever the order of their fields. */
export function sameContent(a: HomeContent, b: HomeContent): boolean {
  return canonical(a) === canonical(b);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Whether the countdown card has reached its moment on this clock. */
export const countdownReached = (card: CountdownCard, now: number): boolean =>
  Date.parse(card.at) <= now;
