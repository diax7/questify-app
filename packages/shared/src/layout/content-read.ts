import { cleanAnnouncementText } from "#src/announcements/announcements";

/**
 * The reading rules the organizer's words share, on Home (T-610) and on the event info page and custom page (T-613): plain
 * text cleaned and bounded by the server, https-only links, and a reader that never throws. `strict` is the organizer's save;
 * the other mode is the app and the API reading what was stored.
 */

export const LINK_URL_MAX = 300;

/** Words an organizer wrote in each language; an empty string is a language left out. */
export type LocalText = Readonly<{ ar: string; en: string }>;

export type ContentIssue = Readonly<{ path: string; message: string }>;
export type Read<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; path: string; message: string }>;
/** `strict` is the organizer's save: texts are cleaned first and a field this block does not have is refused. */
export type Mode = Readonly<{ strict: boolean }>;

export const ok = <T>(value: T): Read<T> => ({ ok: true, value });
export const fail = (path: string, message: string): Read<never> => ({
  ok: false,
  path,
  message,
});
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
export const points = (text: string): number => Array.from(text).length;

const IMAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * An optional organizer image id (T-610b, ADR-829): lowercase when it is one, none when left out. The organizer's save
 * refuses anything else; reading what was stored drops it, so the item shows without its picture.
 */
export function readImageId(raw: unknown, path: string, mode: Mode): Read<string | undefined> {
  if (raw === undefined || raw === null) return ok(undefined);
  if (typeof raw === "string" && IMAGE_ID.test(raw)) return ok(raw.toLowerCase());
  return mode.strict ? fail(path, "must be an image of the event") : ok(undefined);
}

/** `{image}` when there is one, else nothing, so an item without a picture carries no key. */
export const imagePart = (image: string | undefined): { image?: string } =>
  image === undefined ? {} : { image };

/** `https`, a full host name (no address, no user info), an optional port, then a path, query or fragment without spaces. */
const LINK =
  /^https:\/\/(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(?::\d{1,5})?(?:[/?#][^\s\\]*)?$/i;

/** Whether the link's port, when it names one, is a real one (1 to 65535); the pattern alone allows five digits. */
function hasRealPort(url: string): boolean {
  const port = /^https:\/\/[^/?#:]+:(\d{1,5})/i.exec(url)?.[1];
  return port === undefined || (Number(port) >= 1 && Number(port) <= 65535);
}

/** Whether a link may be tapped from the app: https only, to a named host (T-610). */
export const isAllowedLink = (url: string): boolean =>
  url.length <= LINK_URL_MAX && LINK.test(url) && hasRealPort(url) && !hasControlCharacter(url);

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
    return cleanLine(raw);
  }
  const lines = raw.split(/\r\n|\r|\n/u).map(cleanLine);
  const kept = lines.filter((line, index) => line !== "" || (lines[index - 1] ?? "") !== "");
  return kept.join("\n").trim();
}

/** C0 and C1 control characters, which `\s` does not cover; a `\u0000` makes Postgres refuse the stored JSON. */
// oxlint-disable-next-line no-control-regex -- the pattern exists to match control characters
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F]/g;

/** One line as stored: the announcement clean-up, then control characters removed and the gap they leave closed. */
export function cleanLine(raw: string): string {
  return cleanAnnouncementText(cleanAnnouncementText(raw).replace(CONTROL_CHARACTERS, ""));
}

export function readText(
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

export const NEEDS_LANGUAGE = "needs text in Arabic or English";

const blank = (a: string, b: string): boolean => a === "" && b === "";
const languageOf = (value: Record<string, unknown>, lang: "ar" | "en"): unknown =>
  value[lang] ?? "";

export function readLocal(
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

export function readKeys(
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

export type ListRead<T> = Readonly<{ values: T[]; issues: ContentIssue[] }>;

export function readList<T>(
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
