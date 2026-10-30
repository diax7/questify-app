import { expect, type Page } from "@playwright/test";

/** The smallest text a dashboard page may show (ADR-364). */
export const MIN_TEXT_PX = 14;

export type LayoutProblems = Readonly<{
  overflow: number;
  overlaps: string[];
  smallText: string[];
  brokenWords: string[];
}>;

/**
 * Reads the page as the person sees it: how far it scrolls sideways, which visible controls cover each other, which
 * visible text is under 14px, and which text is squeezed so narrow that its words break apart. While a modal dialog is
 * open it reads the dialog alone, and it leaves out controls in an inert part of the page (behind the phone menu),
 * since those are covered on purpose. Runs inside the browser, so it may only use what it is given.
 */
function measure(minText: number): LayoutProblems {
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- page.evaluate sends only this function's source.
  const visible = (element: Element): boolean => {
    const box = element.getBoundingClientRect();
    if (box.width < 2 || box.height < 2) {
      return false;
    }
    const style = getComputedStyle(element);
    return style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0";
  };
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- page.evaluate sends only this function's source.
  const describe = (element: Element): string => {
    const text = (element.textContent ?? "").trim().slice(0, 40);
    const label = element.getAttribute("aria-label") ?? element.getAttribute("name") ?? "";
    return `<${element.tagName.toLowerCase()}> "${label || text}"`;
  };

  const modal = document.querySelector("dialog:modal");
  const controls = [
    ...(modal ?? document).querySelectorAll(
      "a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=tab]",
    ),
  ]
    .filter(visible)
    .filter((control) => control.closest("[inert]") === null);
  const overlaps: string[] = [];
  for (const [index, first] of controls.entries()) {
    const a = first.getBoundingClientRect();
    for (const second of controls.slice(index + 1)) {
      if (first.contains(second) || second.contains(first)) {
        continue;
      }
      const b = second.getBoundingClientRect();
      const width = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (width > 1 && height > 1) {
        overlaps.push(`${describe(first)} and ${describe(second)}`);
      }
    }
  }

  const smallText: string[] = [];
  const brokenWords: string[] = [];
  const walker = document.createTreeWalker(modal ?? document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const parent = node.parentElement;
    const text = (node.textContent ?? "").trim();
    if (parent === null || text === "" || !visible(parent)) {
      continue;
    }
    const size = Number.parseFloat(getComputedStyle(parent).fontSize);
    if (size < minText) {
      smallText.push(`${describe(parent)} at ${size}px`);
    }
    // A box too narrow for its words breaks them letter by letter: more lines than words. Text with a long single
    // token (an email address, a link) may wrap inside it and is left out.
    const words = text.split(/\s+/);
    const range = document.createRange();
    range.selectNodeContents(node);
    const lines = new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size;
    if (words.every((word) => word.length <= 24) && lines > words.length) {
      brokenWords.push(`${describe(parent)} on ${lines} lines`);
    }
  }

  const root = document.documentElement;
  return { overflow: root.scrollWidth - root.clientWidth, overlaps, smallText, brokenWords };
}

/** The open page's layout problems, as the check sees them. */
export function readLayout(page: Page): Promise<LayoutProblems> {
  return page.evaluate(measure, MIN_TEXT_PX);
}

/**
 * Fails the test when the open page scrolls sideways, has controls on top of each other, text under 14px, or words
 * squeezed apart.
 */
export async function expectCleanLayout(page: Page, where: string): Promise<void> {
  const problems = await readLayout(page);
  expect.soft(problems.overflow, `${where}: scrolls sideways by ${problems.overflow}px`).toBe(0);
  expect.soft(problems.overlaps, `${where}: controls on top of each other`).toEqual([]);
  expect.soft(problems.smallText, `${where}: text under ${MIN_TEXT_PX}px`).toEqual([]);
  expect.soft(problems.brokenWords, `${where}: words broken across lines`).toEqual([]);
}

/**
 * Fails the test when the desktop navigation column needs its own scrollbar: every group, the last one included, must
 * be on screen at once (ADR-366). Does nothing below 64rem, where the navigation is the phone menu.
 */
export async function expectNavFits(page: Page, where: string): Promise<void> {
  const hidden = await page.evaluate(() => {
    const column = document.querySelector("nav#shell-navigation");
    if (column === null || window.innerWidth < 1024) {
      return 0;
    }
    return column.scrollHeight - column.clientHeight;
  });
  expect
    .soft(hidden, `${where}: navigation runs ${hidden}px below the screen`)
    .toBeLessThanOrEqual(0);
}

/** What a page needs to know to build its address: the organizer and event the run created. */
export type LayoutIds = Readonly<{ organizerId: string; eventId: string }>;

export type LayoutPage = Readonly<{
  /** A short file-safe name, used for the screenshot. */
  name: string;
  /** The path after the language, e.g. `/organizers/{id}/events`. */
  path: (ids: LayoutIds) => string;
  /** Text the finished page shows, so the check waits for the data and not only the first paint. */
  ready: Readonly<{ en: string; ar: string }>;
}>;

const event = (ids: LayoutIds): string => `/organizers/${ids.organizerId}/events/${ids.eventId}`;

/**
 * Every signed-in page the layout check walks (ADR-364). T-599b adds the rest of the dashboard and console pages here;
 * TASKS.md lists those still missing.
 */
export const LAYOUT_PAGES: readonly LayoutPage[] = [
  { name: "home", path: () => "", ready: { en: "Your organizers", ar: "الجهات المنظِّمة" } },
  {
    name: "events",
    path: (ids) => `/organizers/${ids.organizerId}/events`,
    ready: { en: "Layout Fest", ar: "مهرجان التخطيط" },
  },
  {
    name: "event-new",
    path: (ids) => `/organizers/${ids.organizerId}/events/new`,
    ready: { en: "Create event", ar: "إنشاء الفعالية" },
  },
  { name: "event", path: event, ready: { en: "Save changes", ar: "حفظ التغييرات" } },
  {
    name: "quests",
    path: (ids) => `${event(ids)}/quests`,
    ready: { en: "Find the stage", ar: "ابحث عن المسرح" },
  },
  {
    name: "rewards",
    path: (ids) => `${event(ids)}/rewards`,
    ready: { en: "No rewards yet.", ar: "لا جوائز بعد." },
  },
  {
    name: "team",
    path: (ids) => `/organizers/${ids.organizerId}/team`,
    ready: { en: "Invite an editor", ar: "دعوة محرر" },
  },
];
