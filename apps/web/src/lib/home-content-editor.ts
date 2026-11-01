import {
  HOME_BLOCKS,
  HOME_CARDS_MAX,
  cardKey,
  checkHomeContent,
  type BannerSlide,
  type CountdownCard,
  type EventLayout,
  type HomeCard,
  type HomeContent,
  type HomeKey,
  type Language,
  type LocalText,
  type MessageKey,
  type QuickLink,
  type TextCard,
} from "@questify/shared";

export const EMPTY_TEXT: LocalText = { ar: "", en: "" };

const ID_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";

/** A new card's id: eight lowercase letters or digits, from random bytes (a card is named by it for as long as it lives). */
export function newCardId(bytes: Uint8Array = crypto.getRandomValues(new Uint8Array(8))): string {
  return Array.from(bytes, (byte) => ID_CHARS.charAt(byte % ID_CHARS.length)).join("");
}

/** The words in the page's language, else in the other one, else nothing. */
export function pickText(text: LocalText, language: Language): string {
  const other = language === "ar" ? text.en : text.ar;
  return text[language] === "" ? other : text[language];
}

export const emptySlide = (): BannerSlide => ({
  title: EMPTY_TEXT,
  subtitle: EMPTY_TEXT,
  action: { type: "none" },
});

export const emptyLink = (): QuickLink => ({
  label: EMPTY_TEXT,
  icon: "star",
  action: { type: "agenda" },
});

export const newTextCard = (id: string): TextCard => ({
  id,
  kind: "text",
  title: EMPTY_TEXT,
  body: EMPTY_TEXT,
});

/** A new countdown to `at` (a UTC ISO time) that hides when it reaches zero. */
export const newCountdownCard = (id: string, at: string): CountdownCard => ({
  id,
  kind: "countdown",
  label: EMPTY_TEXT,
  at,
  atZero: "hide",
  message: EMPTY_TEXT,
});

export const canAddCard = (layout: EventLayout): boolean =>
  layout.content.cards.length < HOME_CARDS_MAX;

/** The layout with one more card, shown, at the end of Home. */
export function addCard(layout: EventLayout, card: HomeCard): EventLayout {
  return {
    ...layout,
    home: { ...layout.home, order: [...layout.home.order, cardKey(card.id)] },
    content: { ...layout.content, cards: [...layout.content.cards, card] },
  };
}

/** The layout without a card: its words, its place in Home and its switch all go. */
export function removeCard(layout: EventLayout, id: string): EventLayout {
  const key = cardKey(id);
  return {
    ...layout,
    home: {
      order: layout.home.order.filter((item) => item !== key),
      hidden: layout.home.hidden.filter((item) => item !== key),
    },
    content: { ...layout.content, cards: layout.content.cards.filter((card) => card.id !== id) },
  };
}

/** The layout with one card changed. */
export function replaceCard(layout: EventLayout, card: HomeCard): EventLayout {
  return {
    ...layout,
    content: {
      ...layout.content,
      cards: layout.content.cards.map((entry) => (entry.id === card.id ? card : entry)),
    },
  };
}

/** The list with the item at `index` moved one place earlier (-1) or later (1); a move off either end changes nothing. */
export function moveWithin<T>(items: readonly T[], index: number, step: -1 | 1): T[] {
  const target = index + step;
  const moving = items[index];
  const other = items[target];
  if (moving === undefined || other === undefined) {
    return [...items];
  }
  return items.map((item, position) =>
    position === index ? other : position === target ? moving : item,
  );
}

/** The label of a Home row: a block's title, or a card's own words (its kind's name while it has none). */
export function homeLabel(
  key: HomeKey,
  content: HomeContent,
  language: Language,
  t: (key: MessageKey) => string,
): string {
  const block = HOME_BLOCKS.find((entry) => entry.block === key);
  if (block !== undefined) {
    return t(block.title);
  }
  const card = content.cards.find((entry) => cardKey(entry.id) === key);
  if (card === undefined) {
    return key;
  }
  const own = pickText(card.kind === "text" ? card.title : card.label, language);
  return own === "" ? t(card.kind === "text" ? "layout.card.text" : "layout.card.countdown") : own;
}

type Problem = Readonly<{ part: string; field?: string; detail?: string; key: MessageKey }>;

/** Which words say what is wrong, by where in the content the server's check found it; the first rule that fits wins. */
const PROBLEMS: readonly Problem[] = [
  { part: "banner", detail: "url", key: "layout.problem.url" },
  { part: "quickLinks", detail: "url", key: "layout.problem.url" },
  { part: "banner", detail: "questId", key: "layout.problem.quest" },
  { part: "quickLinks", detail: "questId", key: "layout.problem.quest" },
  { part: "featured", key: "layout.problem.featured" },
  { part: "banner", field: "title", key: "layout.problem.slideTitle" },
  { part: "quickLinks", field: "label", key: "layout.problem.linkLabel" },
  { part: "cards", field: "body", key: "layout.problem.cardText" },
  { part: "cards", field: "label", key: "layout.problem.cardText" },
  { part: "cards", field: "at", key: "layout.problem.cardTime" },
  { part: "cards", field: "message", key: "layout.problem.cardMessage" },
];

/** What is wrong with the content, in the organizer's words: the first problem, or null when it can be saved. */
export function contentProblem(
  content: HomeContent,
): Readonly<{ key: MessageKey; n: number }> | null {
  const checked = checkHomeContent(content);
  const issue = checked.ok ? undefined : checked.issues[0];
  if (issue === undefined) {
    return null;
  }
  const [, part, position, field, detail] = issue.path.split(".");
  const rule = PROBLEMS.find(
    (entry) =>
      entry.part === part &&
      (entry.field === undefined || entry.field === field) &&
      (entry.detail === undefined || entry.detail === detail),
  );
  const n = /^\d+$/.test(position ?? "") ? Number(position) + 1 : 1;
  return { key: rule?.key ?? "layout.problem.other", n };
}
