import type { Language } from "@questify/shared";

export type LegalBlock =
  | Readonly<{ kind: "heading"; level: 2 | 3; text: string }>
  | Readonly<{ kind: "paragraph"; text: string }>
  | Readonly<{ kind: "list"; items: readonly string[] }>;

const AR_START = '<div dir="rtl" lang="ar">';
const AR_END = "</div>";

/** Takes the one language's half of a legal draft: the Arabic block, or everything after it. */
function halfFor(markdown: string, language: Language): string[] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const start = lines.indexOf(AR_START);
  const end = lines.indexOf(AR_END, start + 1);
  if (start < 0 || end < 0) {
    return [];
  }
  return language === "ar" ? lines.slice(start + 1, end) : lines.slice(end + 1);
}

/** Plain text: emphasis markers and link syntax are dropped, so nothing but text reaches the page. */
const plain = (text: string): string =>
  text
    .replace(/\*\*|__/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .trim();

/**
 * Turns one language of a legal draft (`docs/legal/*.md`: Arabic first inside a right-to-left block, then English) into
 * headings, paragraphs and lists. Deliberately small: the drafts use only these, and no HTML from the file is ever
 * rendered.
 */
export function legalBlocks(markdown: string, language: Language): LegalBlock[] {
  return blocksOf(halfFor(markdown, language));
}

/** The same small markdown for a text an admin published, which holds one language (FR-1781). */
export function legalTextBlocks(text: string): LegalBlock[] {
  return blocksOf(text.replace(/\r\n/g, "\n").split("\n"));
}

const HEADING = /^(#{2,3})\s+(.*)$/;
const LIST_ITEM = /^[-*]\s+/;
const isBreak = (line: string): boolean => line === "" || line === "---" || line.startsWith("<");

function blocksOf(lines: readonly string[]): LegalBlock[] {
  const blocks: LegalBlock[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];
  const closeParagraph = (): void => {
    if (paragraph.length > 0) {
      blocks.push({ kind: "paragraph", text: plain(paragraph.join(" ")) });
      paragraph = [];
    }
  };
  const closeList = (): void => {
    if (list.length > 0) {
      blocks.push({ kind: "list", items: list.map(plain) });
      list = [];
    }
  };
  for (const raw of lines) {
    const line = raw.trim();
    const heading = HEADING.exec(line);
    if (heading !== null) {
      closeParagraph();
      closeList();
      blocks.push({
        kind: "heading",
        level: heading[1] === "##" ? 2 : 3,
        text: plain(heading[2] ?? ""),
      });
    } else if (LIST_ITEM.test(line)) {
      closeParagraph();
      list.push(line.replace(LIST_ITEM, ""));
    } else if (isBreak(line)) {
      closeParagraph();
      closeList();
    } else {
      closeList();
      paragraph.push(line);
    }
  }
  closeParagraph();
  closeList();
  return blocks;
}
