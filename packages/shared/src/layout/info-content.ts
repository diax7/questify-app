import { toWesternDigits } from "#src/i18n/digits";
import {
  NEEDS_LANGUAGE,
  cleanLine,
  fail,
  isAllowedLink,
  ok,
  points,
  readImageId,
  readKeys,
  readList,
  readLocal,
  type ListRead,
  type LocalText,
  type Mode,
  type Read,
} from "#src/layout/content-read";

/**
 * What an organizer writes for the event info page and the one extra custom page (T-613, FR-1835): an About text, questions
 * and answers, and ways to reach the organizer (the info page), and a page of headings, text, lists and links. It is stored in
 * `event.config.layout.content` beside the Home content (ADR-395, ADR-398). Every text is plain, and nothing in it is
 * tappable except a contact (an email, a phone number or an https link) or a link the organizer chose.
 */

export const FAQ_MAX = 12;
export const CONTACTS_MAX = 5;
export const PAGE_BLOCKS_MAX = 12;
export const LIST_ITEMS_MAX = 10;

/** Longest text per field, in code points. */
export const INFO_LIMITS = {
  about: 1000,
  question: 120,
  answer: 500,
  contactLabel: 40,
  contactValue: 120,
  pageTitle: 60,
  heading: 60,
  paragraph: 600,
  listItem: 120,
  linkLabel: 40,
  imageAlt: 120,
} as const;

export const CONTACT_KINDS = ["email", "phone", "link"] as const;
export type ContactKind = (typeof CONTACT_KINDS)[number];

export type FaqEntry = Readonly<{ question: LocalText; answer: LocalText }>;
export type Contact = Readonly<{ label: LocalText; kind: ContactKind; value: string }>;

/** One part of the custom page. A list holds one item per line of its text. */
export type PageBlock =
  | Readonly<{ kind: "heading"; text: LocalText }>
  | Readonly<{ kind: "text"; text: LocalText }>
  | Readonly<{ kind: "list"; items: LocalText }>
  | Readonly<{ kind: "link"; label: LocalText; url: string }>
  /** An organizer picture (T-613b); `alt` says what it shows, for a screen reader, in each language. */
  | Readonly<{ kind: "image"; image: string; alt: LocalText }>;
export type PageBlockKind = PageBlock["kind"];
export const PAGE_BLOCK_KINDS: readonly PageBlockKind[] = [
  "heading",
  "text",
  "list",
  "link",
  "image",
];

export type CustomPage = Readonly<{ title: LocalText; blocks: readonly PageBlock[] }>;

/** The About text, the questions and answers and the contacts of the info page. */
export type InfoContent = Readonly<{
  about: LocalText;
  faq: readonly FaqEntry[];
  contacts: readonly Contact[];
}>;

/** The lines of a list's text: one item each, none empty. */
export const listItems = (text: string): string[] =>
  text.split("\n").filter((line) => line.trim() !== "");

const NO_TEXT = { ar: "", en: "" } as const;

/** An address with no `%`, `?` or `&`, so a `mailto:` link made of it can carry nothing but the address. */
const EMAIL = /^[a-z0-9._+-]{1,64}@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const PHONE = /^\+?[0-9]{7,15}$/;
const PHONE_SEPARATORS = /[\s().-]/g;

function readFaqEntry(raw: unknown, path: string, mode: Mode): Read<FaqEntry> {
  const found = readKeys(raw, path, ["question", "answer"], mode);
  if (!found.ok) return found;
  const question = readLocal(
    found.value["question"],
    `${path}.question`,
    INFO_LIMITS.question,
    mode,
    { required: true },
  );
  const answer = readLocal(found.value["answer"], `${path}.answer`, INFO_LIMITS.answer, mode, {
    required: true,
    multiline: true,
  });
  if (!question.ok) return question;
  return answer.ok ? ok({ question: question.value, answer: answer.value }) : answer;
}

/**
 * The value of a contact as stored: cleaned like any line when it is saved, trimmed and in Western digits when it is read; a
 * phone number loses its spaces and punctuation either way, so the dashboard's preview of a draft agrees with what is saved.
 */
function contactValue(kind: ContactKind, raw: string, mode: Mode): string {
  const typed = toWesternDigits(mode.strict ? cleanLine(raw) : raw.trim());
  return kind === "phone" ? typed.replace(PHONE_SEPARATORS, "") : typed;
}

function readContactValue(kind: ContactKind, raw: unknown, path: string, mode: Mode): Read<string> {
  if (typeof raw !== "string") {
    return fail(path, "must be text");
  }
  const value = contactValue(kind, raw, mode);
  if (kind === "email") {
    return points(value) <= INFO_LIMITS.contactValue && EMAIL.test(value)
      ? ok(value)
      : fail(path, "must be an email address");
  }
  if (kind === "phone") {
    return PHONE.test(value) ? ok(value) : fail(path, "must be a phone number of 7 to 15 digits");
  }
  return isAllowedLink(value) ? ok(value) : fail(path, "must be a full https link");
}

function readContact(raw: unknown, path: string, mode: Mode): Read<Contact> {
  const found = readKeys(raw, path, ["label", "kind", "value"], mode);
  if (!found.ok) return found;
  const label = readLocal(found.value["label"], `${path}.label`, INFO_LIMITS.contactLabel, mode, {
    required: true,
  });
  const kind = CONTACT_KINDS.find((name) => name === found.value["kind"]);
  if (!label.ok) return label;
  if (kind === undefined) return fail(`${path}.kind`, "is not a way to reach the organizer");
  const value = readContactValue(kind, found.value["value"], `${path}.value`, mode);
  return value.ok ? ok({ label: label.value, kind, value: value.value }) : value;
}

/** The text of a list: one item per line, at most 10, each within its limit; blank lines are dropped when it is saved. */
function readItems(raw: unknown, path: string, mode: Mode): Read<LocalText> {
  const total = LIST_ITEMS_MAX * (INFO_LIMITS.listItem + 1);
  const text = readLocal(raw, path, total, mode, { required: true, multiline: true });
  if (!text.ok) return text;
  const tidy = (value: string): string => (mode.strict ? listItems(value).join("\n") : value);
  const items = { ar: tidy(text.value.ar), en: tidy(text.value.en) };
  const tooLong = [items.ar, items.en].some((value) =>
    listItems(value).some((line) => points(line) > INFO_LIMITS.listItem),
  );
  const tooMany = [items.ar, items.en].some((value) => listItems(value).length > LIST_ITEMS_MAX);
  if (tooLong) return fail(path, `has an item longer than ${INFO_LIMITS.listItem} characters`);
  if (tooMany) return fail(path, `has more than ${LIST_ITEMS_MAX} items`);
  return items.ar === "" && items.en === "" ? fail(path, NEEDS_LANGUAGE) : ok(items);
}

const BLOCK_KEYS: Readonly<Record<PageBlockKind, readonly string[]>> = {
  heading: ["kind", "text"],
  text: ["kind", "text"],
  list: ["kind", "items"],
  link: ["kind", "label", "url"],
  image: ["kind", "image", "alt"],
};

/** An image part: a stored picture's id and its words; reading what was stored drops a part whose id is no id. */
function readImageBlock(found: Record<string, unknown>, path: string, mode: Mode): Read<PageBlock> {
  const alt = readLocal(found["alt"], `${path}.alt`, INFO_LIMITS.imageAlt, mode, {
    required: true,
  });
  const image = readImageId(found["image"], `${path}.image`, { strict: true });
  if (!alt.ok) return alt;
  if (!image.ok) return image;
  return image.value === undefined
    ? fail(`${path}.image`, "must be an image of the event")
    : ok({ kind: "image", image: image.value, alt: alt.value });
}

function readLinkBlock(found: Record<string, unknown>, path: string, mode: Mode): Read<PageBlock> {
  const label = readLocal(found["label"], `${path}.label`, INFO_LIMITS.linkLabel, mode, {
    required: true,
  });
  const url = typeof found["url"] === "string" ? found["url"].trim() : "";
  if (!label.ok) return label;
  return isAllowedLink(url)
    ? ok({ kind: "link", label: label.value, url })
    : fail(`${path}.url`, "must be a full https link");
}

function readBlockBody(
  kind: PageBlockKind,
  found: Record<string, unknown>,
  path: string,
  mode: Mode,
): Read<PageBlock> {
  if (kind === "link") return readLinkBlock(found, path, mode);
  if (kind === "image") return readImageBlock(found, path, mode);
  if (kind === "list") {
    const items = readItems(found["items"], `${path}.items`, mode);
    return items.ok ? ok({ kind, items: items.value }) : items;
  }
  const heading = kind === "heading";
  const text = readLocal(
    found["text"],
    `${path}.text`,
    heading ? INFO_LIMITS.heading : INFO_LIMITS.paragraph,
    mode,
    { required: true, multiline: !heading },
  );
  return text.ok ? ok({ kind, text: text.value }) : text;
}

function readBlock(raw: unknown, path: string, mode: Mode): Read<PageBlock> {
  const kind = PAGE_BLOCK_KINDS.find(
    (name) => typeof raw === "object" && raw !== null && "kind" in raw && raw.kind === name,
  );
  if (kind === undefined) {
    return fail(`${path}.kind`, "must be heading, text, list, link or image");
  }
  const found = readKeys(raw, path, BLOCK_KEYS[kind], mode);
  return found.ok ? readBlockBody(kind, found.value, path, mode) : found;
}

/**
 * The custom page: a title and its parts. In the organizer's save a part that is not valid is refused; when the app reads the
 * stored page it leaves that part out, and a page left with no part is no page.
 */
function readPage(raw: unknown, path: string, mode: Mode): Read<CustomPage | null> {
  if (raw === null || raw === undefined) {
    return ok(null);
  }
  const found = readKeys(raw, path, ["title", "blocks"], mode);
  if (!found.ok) return found;
  const title = readLocal(found.value["title"], `${path}.title`, INFO_LIMITS.pageTitle, mode, {
    required: true,
  });
  const blocks = readList(found.value["blocks"], `${path}.blocks`, PAGE_BLOCKS_MAX, (item, at) =>
    readBlock(item, at, mode),
  );
  if (!title.ok) return title;
  const problem = mode.strict ? blocks.issues[0] : undefined;
  if (problem !== undefined) return fail(problem.path, problem.message);
  return blocks.values.length === 0
    ? fail(`${path}.blocks`, "needs at least one part")
    : ok({ title: title.value, blocks: blocks.values });
}

export type InfoRead = Readonly<{
  info: InfoContent;
  page: CustomPage | null;
  issues: readonly Readonly<{ path: string; message: string }>[];
}>;

/**
 * Reads the info page's words and the custom page out of the stored content. In the organizer's save every problem is an
 * issue with its path; reading what was stored, a part that is not valid is left out and nothing throws.
 */
export function readInfoParts(source: Record<string, unknown>, mode: Mode): InfoRead {
  const about = readLocal(source["about"] ?? NO_TEXT, "content.about", INFO_LIMITS.about, mode, {
    required: false,
    multiline: true,
  });
  const faq: ListRead<FaqEntry> = readList(source["faq"], "content.faq", FAQ_MAX, (item, at) =>
    readFaqEntry(item, at, mode),
  );
  const contacts = readList(source["contacts"], "content.contacts", CONTACTS_MAX, (item, at) =>
    readContact(item, at, mode),
  );
  const page = readPage(source["page"], "content.page", mode);
  return {
    info: {
      about: about.ok ? about.value : NO_TEXT,
      faq: faq.values,
      contacts: contacts.values,
    },
    page: page.ok ? page.value : null,
    issues: [
      ...(about.ok ? [] : [{ path: about.path, message: about.message }]),
      ...faq.issues,
      ...contacts.issues,
      ...(page.ok ? [] : [{ path: page.path, message: page.message }]),
    ],
  };
}

/** Whether a page has anything to show: a title and a part. */
export const pageShown = (page: CustomPage | null): page is CustomPage =>
  page !== null && page.blocks.length > 0;
