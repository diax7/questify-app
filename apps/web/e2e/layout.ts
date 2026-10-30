import { expect, type Page } from "@playwright/test";
import { DEFAULT_TERMS, MESSAGES, termFor, type MessageKey } from "@questify/shared";

/** The smallest text a dashboard page may show (ADR-364). */
export const MIN_TEXT_PX = 14;

/** The contrast the web content guidelines (WCAG AA) ask for: 4.5 to 1 for text, 3 to 1 for large text. */
export const MIN_CONTRAST = 4.5;
export const MIN_CONTRAST_LARGE = 3;

export type LayoutProblems = Readonly<{
  overflow: number;
  overlaps: string[];
  textOverlaps: string[];
  smallText: string[];
  brokenWords: string[];
  /** Text squeezed into a column so narrow that it wraps a word to a line, or a control that does. */
  cramped: string[];
  /** A card or section drawn inside another: a page shows one box level. */
  nestedBoxes: string[];
}>;

/**
 * Reads the page as the person sees it: how far it scrolls sideways, which visible controls cover each other, which
 * lines of text cover each other or a control, which visible text is under 14px, and which text is squeezed so narrow
 * that its words break apart, which text or controls are crammed into a narrow column, and which boxes sit inside
 * other boxes. While a modal dialog is open it reads the dialog alone, and it leaves out what sits in an
 * inert part of the page (behind the phone menu), since that is covered on purpose. Runs inside the browser, so it may
 * only use what it is given.
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
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- page.evaluate sends only this function's source.
  const crossing = (a: DOMRect, b: DOMRect): boolean =>
    Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 &&
    Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1;
  // The boxes of an element: one per line it is drawn on (a link that wraps covers its two lines, not the text between).
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- page.evaluate sends only this function's source.
  const boxesOf = (element: Element): DOMRect[] =>
    [...element.getClientRects()].filter((box) => box.width > 0 && box.height > 0);
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- page.evaluate sends only this function's source.
  const touching = (first: Element, second: Element): boolean =>
    boxesOf(first).some((a) => boxesOf(second).some((b) => crossing(a, b)));

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
    for (const second of controls.slice(index + 1)) {
      if (!first.contains(second) && !second.contains(first) && touching(first, second)) {
        overlaps.push(`${describe(first)} and ${describe(second)}`);
      }
    }
  }

  const smallText: string[] = [];
  const brokenWords: string[] = [];
  const lines: { owner: Element; text: string; box: DOMRect }[] = [];
  const walker = document.createTreeWalker(modal ?? document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const parent = node.parentElement;
    const text = (node.textContent ?? "").trim();
    if (parent === null || text === "" || !visible(parent) || parent.closest("[inert]") !== null) {
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
    const rects = [...range.getClientRects()];
    const rows = new Set(rects.map((rect) => Math.round(rect.top))).size;
    if (words.every((word) => word.length <= 24) && rows > words.length) {
      brokenWords.push(`${describe(parent)} on ${rows} lines`);
    }
    // Only the middle of each line is compared: the box of a line is taller than its letters, so two lines of one
    // paragraph may touch by a pixel or two without covering each other.
    if (parent.closest("option, select, textarea, script, style") === null) {
      for (const rect of rects) {
        const trim = rect.height * 0.2;
        lines.push({
          owner: parent,
          text,
          box: new DOMRect(rect.x, rect.y + trim, rect.width, rect.height - 2 * trim),
        });
      }
    }
  }

  // A box is a block with a solid border on every side and a fill (a card, a section, a form drawn as a card). A notice
  // has a thicker edge on one side and an empty state a dashed one, so neither counts. One box inside another is a fault.
  const boxes = [
    ...(modal ?? document.body).querySelectorAll(
      "div, section, article, li, form, ul, ol, dl, p, header, aside, fieldset, details",
    ),
  ].filter((element) => {
    if (!visible(element) || element.closest("[inert]") !== null) {
      return false;
    }
    const style = getComputedStyle(element);
    const edges = [
      style.borderTopWidth,
      style.borderRightWidth,
      style.borderBottomWidth,
      style.borderLeftWidth,
    ];
    return (
      !style.display.startsWith("inline") &&
      edges.every((edge) => edge === edges[0] && Number.parseFloat(edge) >= 1) &&
      style.borderTopStyle === "solid" &&
      style.backgroundColor !== "rgba(0, 0, 0, 0)" &&
      style.backgroundColor !== "transparent"
    );
  });
  const nestedBoxes = boxes
    .filter((box) => boxes.some((other) => other !== box && other.contains(box)))
    .map(describe);

  // A control whose label wraps in a column under 112px, or a heading or paragraph squeezed under 140px (200px for a
  // heading) onto three lines or more, is crammed: the room was there and the layout did not use it.
  const cramped: string[] = [];
  for (const control of controls) {
    const width = control.getBoundingClientRect().width;
    const range = document.createRange();
    range.selectNodeContents(control);
    const rows = new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size;
    if ((control.textContent ?? "").trim().split(/\s+/).length > 1 && rows > 1 && width < 112) {
      cramped.push(`${describe(control)} wraps word by word in ${Math.round(width)}px`);
    }
  }
  for (const line of lines) {
    const block = line.owner.getBoundingClientRect();
    const heading = line.owner.closest("h1, h2, h3") !== null;
    const rowsInBlock = Math.round(block.height / Math.max(1, line.box.height / 0.6));
    if (
      line.text.split(/\s+/).length >= 3 &&
      rowsInBlock >= 3 &&
      block.width < (heading ? 200 : 140)
    ) {
      cramped.push(`${describe(line.owner)} squeezed into ${Math.round(block.width)}px`);
    }
  }

  const textOverlaps: string[] = [];
  for (const [index, first] of lines.entries()) {
    for (const second of lines.slice(index + 1)) {
      if (first.owner !== second.owner && crossing(first.box, second.box)) {
        textOverlaps.push(`"${first.text.slice(0, 30)}" and "${second.text.slice(0, 30)}"`);
      }
    }
    for (const control of controls) {
      if (
        !control.contains(first.owner) &&
        boxesOf(control).some((box) => crossing(first.box, box))
      ) {
        textOverlaps.push(`"${first.text.slice(0, 30)}" under ${describe(control)}`);
      }
    }
  }

  const root = document.documentElement;
  return {
    overflow: root.scrollWidth - root.clientWidth,
    overlaps,
    textOverlaps,
    smallText,
    brokenWords,
    cramped: [...new Set(cramped)],
    nestedBoxes,
  };
}

/**
 * Reads the contrast of every visible piece of text under an element (the whole page when none is given): its colour
 * over the colours behind it, as drawn now, so a hovered or focused element is read in that state. Disabled controls
 * are left out, as the guidelines do. Runs inside the browser, so it may only use what it is given: called by
 * `page.evaluate(contrastOf, limits)` or `locator.evaluate(contrastOf, limits)`.
 */
export function contrastOf(
  first: Element | readonly [number, number],
  second?: readonly [number, number],
): string[] {
  type Colour = [number, number, number, number];
  const root = first instanceof Element ? first : document.body;
  const limits = (first instanceof Element ? second : first) ?? [4.5, 3];
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- page.evaluate sends only this function's source.
  const parse = (value: string): Colour | null => {
    const rgb = /^rgba?\(([^)]+)\)$/.exec(value);
    if (rgb?.[1] !== undefined) {
      const [r = 0, g = 0, b = 0, a = 1] = rgb[1]
        .split(/[\s,/]+/)
        .filter(Boolean)
        .map(Number);
      return [r, g, b, a];
    }
    const srgb = /^color\(srgb ([^)]+)\)$/.exec(value);
    if (srgb?.[1] !== undefined) {
      const [r = 0, g = 0, b = 0, a = 1] = srgb[1]
        .split(/[\s/]+/)
        .filter(Boolean)
        .map(Number);
      return [r * 255, g * 255, b * 255, a];
    }
    return null;
  };
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- page.evaluate sends only this function's source.
  const over = (front: Colour, back: Colour): Colour => {
    const alpha = front[3] + back[3] * (1 - front[3]);
    const mix = (index: 0 | 1 | 2): number =>
      alpha === 0 ? 0 : (front[index] * front[3] + back[index] * back[3] * (1 - front[3])) / alpha;
    return [mix(0), mix(1), mix(2), alpha];
  };
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- page.evaluate sends only this function's source.
  const luminance = (colour: Colour): number => {
    // oxlint-disable-next-line unicorn/consistent-function-scoping -- page.evaluate sends only this function's source.
    const part = (value: number): number => {
      const unit = value / 255;
      return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * part(colour[0]) + 0.7152 * part(colour[1]) + 0.0722 * part(colour[2]);
  };
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- page.evaluate sends only this function's source.
  const behind = (element: Element): Colour | string => {
    let result: Colour = [255, 255, 255, 1];
    const chain: Element[] = [];
    for (let up: Element | null = element; up !== null; up = up.parentElement) {
      chain.push(up);
    }
    for (const layer of chain.toReversed()) {
      const style = getComputedStyle(layer);
      if (style.backgroundImage !== "none") {
        return "an image";
      }
      const fill = parse(style.backgroundColor);
      if (fill === null) {
        return `a colour it cannot read (${style.backgroundColor})`;
      }
      result = over(fill, result);
    }
    return result;
  };

  const failures: string[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const seen = new Set<Element>();
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const element = node.parentElement;
    if (element === null || seen.has(element) || (node.textContent ?? "").trim() === "") {
      continue;
    }
    seen.add(element);
    const box = element.getBoundingClientRect();
    const skipped = "[inert], :disabled, [aria-disabled=true], option, script, style";
    if (box.width < 2 || box.height < 2 || element.closest(skipped) !== null) {
      continue;
    }
    const style = getComputedStyle(element);
    if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) < 1) {
      continue;
    }
    const back = behind(element);
    const ink = parse(style.color);
    const name = `<${element.tagName.toLowerCase()}> "${(element.textContent ?? "").trim().slice(0, 30)}"`;
    if (typeof back === "string" || ink === null) {
      if (typeof back === "string" && back !== "an image") {
        failures.push(`${name} over ${back}`);
      }
      continue;
    }
    const text = over(ink, back);
    const [light = 0, dark = 0] = [luminance(text), luminance(back)].toSorted((a, b) => b - a);
    const ratio = (light + 0.05) / (dark + 0.05);
    const size = Number.parseFloat(style.fontSize);
    const large = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700);
    const needed = large ? limits[1] : limits[0];
    if (ratio < needed) {
      failures.push(`${name} ${ratio.toFixed(2)}:1, needs ${needed}:1`);
    }
  }
  return failures;
}

const LIMITS = [MIN_CONTRAST, MIN_CONTRAST_LARGE] as const;

/** The contrast problems of the open page, as drawn now. */
export function readContrast(page: Page): Promise<string[]> {
  return page.evaluate(contrastOf, LIMITS);
}

/**
 * Reads the contrast of the controls the pointer can rest on and the keyboard can reach: each one hovered, then
 * focused, because a state colour is where light text lands on a light fill. `chrome` is the top bar and the
 * navigation (read once per kind of page), else the first controls of the page body.
 */
export async function expectStateContrast(
  page: Page,
  where: string,
  scope: "chrome" | "body",
): Promise<void> {
  const selector =
    scope === "chrome"
      ? "header a, header button, nav#shell-navigation a"
      : "main a, main button, main summary";
  const targets = page.locator(selector).filter({ visible: true });
  const count = Math.min(await targets.count(), scope === "chrome" ? 12 : 5);
  await page.keyboard.press("Tab");
  for (let index = 0; index < count; index += 1) {
    const target = targets.nth(index);
    const name = (await target.textContent())?.trim().slice(0, 30) ?? "";
    await target.hover({ timeout: 3000 });
    await page.waitForTimeout(160);
    expect
      .soft(await target.evaluate(contrastOf, LIMITS), `${where}: "${name}" hovered`)
      .toEqual([]);
    await target.focus();
    await page.waitForTimeout(160);
    expect
      .soft(await target.evaluate(contrastOf, LIMITS), `${where}: "${name}" focused`)
      .toEqual([]);
  }
  await page.mouse.move(0, 0);
}

/** The open page's layout problems, as the check sees them. */
export function readLayout(page: Page): Promise<LayoutProblems> {
  return page.evaluate(measure, MIN_TEXT_PX);
}

/**
 * Fails the test when the open page scrolls sideways, has controls or lines of text on top of each other, text under
 * 14px, or words squeezed apart.
 */
export async function expectCleanLayout(page: Page, where: string): Promise<void> {
  const problems = await readLayout(page);
  expect.soft(problems.overflow, `${where}: scrolls sideways by ${problems.overflow}px`).toBe(0);
  expect.soft(problems.overlaps, `${where}: controls on top of each other`).toEqual([]);
  expect.soft(problems.textOverlaps, `${where}: text on top of text or a control`).toEqual([]);
  expect.soft(problems.smallText, `${where}: text under ${MIN_TEXT_PX}px`).toEqual([]);
  expect.soft(problems.brokenWords, `${where}: words broken across lines`).toEqual([]);
  expect
    .soft(problems.cramped, `${where}: text or controls crammed into a narrow column`)
    .toEqual([]);
  expect.soft(problems.nestedBoxes, `${where}: a box inside another box`).toEqual([]);
  expect.soft(await readContrast(page), `${where}: text without enough contrast`).toEqual([]);
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

/** What a page needs to know to build its address: what the run created. */
export type LayoutIds = Readonly<{
  organizerId: string;
  eventId: string;
  /** The event's join code, for its public page. */
  joinCode: string;
  /** A help request an event team escalated to Questify, for the console's ticket page. */
  ticketId: string;
  /** An invitation request for the event, for the console's request page. */
  campaignId: string;
}>;

export type LayoutPage = Readonly<{
  /** A short file-safe name, used for the screenshot. */
  name: string;
  /** The path after the language, e.g. `/organizers/{id}/events`. */
  path: (ids: LayoutIds) => string;
  /** Text the finished page shows, so the check waits for the data and not only the first paint. */
  ready: Readonly<{ en: string; ar: string }>;
  /** `draft` pages are read while the event is a draft, the rest after the run has filled and started it. */
  phase?: "draft";
}>;

const event = (ids: LayoutIds): string => `/organizers/${ids.organizerId}/events/${ids.eventId}`;
const organizer = (ids: LayoutIds): string => `/organizers/${ids.organizerId}`;

/** The words of a page's title, from the message catalog, so the check reads what the page really says. */
const titled = (key: MessageKey): LayoutPage["ready"] => ({
  en: MESSAGES[key].en,
  ar: MESSAGES[key].ar,
});

/** An event page opened by its folder name, waiting for its title. */
const eventPage = (name: string, key: MessageKey): LayoutPage => ({
  name,
  path: (ids) => `${event(ids)}/${name}`,
  ready: titled(key),
});

/** A console page opened by its folder name, waiting for its title. */
const consolePage = (name: string, key: MessageKey): LayoutPage => ({
  name: `console-${name}`,
  path: () => `/console/${name}`,
  ready: titled(key),
});

/**
 * Every signed-in page the layout check walks (ADR-364, rules.md "Web UI"): a new page is added here. Public pages
 * that need no account are in `PUBLIC_PAGES`.
 */
export const LAYOUT_PAGES: readonly LayoutPage[] = [
  {
    name: "events",
    path: (ids) => `${organizer(ids)}/events`,
    ready: { en: "Layout Fest", ar: "مهرجان التخطيط" },
    phase: "draft",
  },
  {
    name: "event-new",
    path: (ids) => `${organizer(ids)}/events/new`,
    ready: { en: "Create event", ar: "إنشاء الفعالية" },
    phase: "draft",
  },
  {
    name: "event",
    path: event,
    ready: { en: "Save changes", ar: "حفظ التغييرات" },
    phase: "draft",
  },
  {
    name: "quests",
    path: (ids) => `${event(ids)}/quests`,
    ready: { en: "Find the stage", ar: "ابحث عن المسرح" },
    phase: "draft",
  },
  {
    name: "rewards",
    path: (ids) => `${event(ids)}/rewards`,
    ready: { en: "Event hoodie", ar: "هودي الفعالية" },
    phase: "draft",
  },
  { name: "home", path: () => "", ready: titled("staff.organizers") },
  { name: "account", path: () => "/account", ready: titled("staff.account") },
  { name: "organizer-new", path: () => "/organizers/new", ready: titled("staff.newOrganizer") },
  { name: "team", path: (ids) => `${organizer(ids)}/team`, ready: titled("staff.inviteEditor") },
  eventPage("announcements", "announcements.page.title"),
  eventPage("awards", "awards.title"),
  eventPage("big-screen", "bigScreen.title"),
  eventPage("boosts", "boosts.page.title"),
  eventPage("codes", "codes.title"),
  {
    name: "community",
    path: (ids) => `${event(ids)}/community`,
    ready: { en: "Community", ar: "للجميع" },
  },
  eventPage("devices", "devices.title"),
  eventPage("flags", "flags.title"),
  eventPage("help", "tickets.page"),
  eventPage("invitations", "invCampaign.title"),
  eventPage("joining", "joining.title"),
  eventPage("operators", "operators.title"),
  {
    name: "players",
    path: (ids) => `${event(ids)}/players`,
    ready: {
      en: termFor(DEFAULT_TERMS.player, "en"),
      ar: termFor(DEFAULT_TERMS.player, "ar"),
    },
  },
  eventPage("prizes", "prizes.link"),
  eventPage("souvenirs", "souvenir.title"),
  eventPage("submissions", "submissions.title"),
  {
    name: "event-public",
    path: (ids) => `/e/${ids.joinCode}`,
    ready: titled("eventPage.code"),
  },
  { name: "console", path: () => "/console", ready: titled("console.queue") },
  consolePage("content", "console.content.title"),
  {
    name: "console-event",
    path: (ids) => `/console/events/${ids.eventId}`,
    ready: { en: "Layout Fest", ar: "مهرجان التخطيط" },
  },
  consolePage("invitations", "console.invCampaign.title"),
  {
    name: "console-invitation",
    path: (ids) => `/console/invitations/${ids.campaignId}`,
    ready: titled("console.invCampaign.detailTitle"),
  },
  consolePage("questify", "console.questify.title"),
  consolePage("seasons", "console.seasons.title"),
  consolePage("tickets", "console.tickets.title"),
  {
    name: "console-ticket",
    path: (ids) => `/console/tickets/${ids.ticketId}`,
    ready: titled("console.tickets.title"),
  },
];

export type PublicPage = Readonly<{ name: string; path: string; ready: LayoutPage["ready"] }>;

/** The pages anyone can open, read before the run signs in. */
export const PUBLIC_PAGES: readonly PublicPage[] = [
  { name: "sign-in", path: "/sign-in", ready: titled("staff.signIn") },
  { name: "sign-up", path: "/sign-up", ready: titled("staff.signUpTitle") },
  { name: "forgot-password", path: "/forgot-password", ready: titled("staff.forgotTitle") },
  { name: "reset-password", path: "/reset-password", ready: titled("staff.newPasswordTitle") },
  { name: "contact", path: "/contact", ready: titled("contact.title") },
  { name: "delete-account", path: "/delete-account", ready: titled("deletion.title") },
  { name: "opt-out", path: "/opt-out", ready: titled("optOut.title") },
  { name: "legal", path: "/legal/privacy_policy", ready: titled("deletion.title") },
  { name: "invite", path: "/invite", ready: titled("staff.inviteMissing") },
  { name: "invitation", path: "/i", ready: titled("invCampaignPage.title") },
  { name: "operator-invite", path: "/op", ready: titled("invitePage.title") },
  { name: "pair", path: "/pair", ready: titled("pair.landing.title") },
];
