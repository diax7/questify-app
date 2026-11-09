import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  LAYOUT_PAGES,
  PUBLIC_PAGES,
  expectCleanLayout,
  expectNavReachable,
  expectStateContrast,
  openPage,
  watchRequests,
  type LayoutIds,
  type LayoutPage,
} from "#e2e/layout.ts";
import { createEvent, fillShop, startAndFill, type Event } from "#e2e/layout-fill.ts";
import { freshAddress } from "#e2e/mail.ts";
import { openMenu } from "#e2e/nav.ts";

/**
 * The layout check (ADR-364, T-599, T-599b): every page listed in `LAYOUT_PAGES` and `PUBLIC_PAGES`, in English and
 * Arabic, at 1440 wide on the desktop project and 360 on the phone project (FR-1746), with no sideways scrolling, no
 * controls or lines of text on top of each other and no text under 14px. The event is filled first (a prize desk,
 * rewards, a rank prize, a team, players with points, a submission, a flagged case, an escalated ticket, an invitation
 * request), so the pages show their filled states and not only the empty ones. On a phone each page is read again with
 * the Menu sheet open, and one confirmation dialog is read on the event page. With `LAYOUT_SHOTS=<folder>` it also
 * saves a full-page screenshot of each.
 */
const LANGUAGES = ["en", "ar"] as const;
type Language = (typeof LANGUAGES)[number];
const SHOTS = process.env["LAYOUT_SHOTS"];
/** The pages that also have the top bar and the navigation read in their hover and focus states (once is enough). */
const CHROME_PAGES = new Set(["sign-in", "event", "home", "console"]);

/** A full-page screenshot, or with `fullPage` false only the screen (a menu or dialog is fixed to the screen). */
async function shoot(page: Page, project: string, name: string, fullPage = true): Promise<void> {
  if (SHOTS === undefined || SHOTS === "") {
    return;
  }
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${project}-${name}.png`), fullPage });
}

/** One page, read as it opens; on a phone again with the Menu sheet open; on a desktop its column must stay on the screen and show the open page. */
async function checkPage(
  page: Page,
  project: string,
  language: Language,
  listed: Readonly<{ name: string; ready: LayoutPage["ready"] }>,
  path: string,
): Promise<void> {
  const where = `${language} ${listed.name}`;
  await openPage(page, language, path, listed.ready[language], where);
  await expectCleanLayout(page, where);
  await expectNavReachable(page, where);
  await shoot(page, project, `${language}-${listed.name}`);
  if (project === "desktop") {
    await expectStateContrast(page, where, "body");
    if (CHROME_PAGES.has(listed.name)) {
      await expectStateContrast(page, where, "chrome");
    }
  }
  if (project === "phone") {
    await openMenu(page);
    await expectCleanLayout(page, `${where} with the menu open`);
    if (listed.name === "event") {
      await shoot(page, project, `${language}-menu-open`, false);
    }
  }
}

/** The event page's Delete draft confirmation, open, read like a page, then closed with Escape. */
async function checkDialog(
  page: Page,
  project: string,
  language: Language,
  ids: Event,
): Promise<void> {
  await page.goto(`/${language}/organizers/${ids.organizerId}/events/${ids.eventId}`);
  await page
    .getByRole("button", { name: language === "en" ? "Delete draft" : "حذف المسودة" })
    .click();
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await expectCleanLayout(page, `${language} event confirmation dialog`);
  await shoot(page, project, `${language}-confirm-dialog`, false);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
}

test("every listed page has its own name, so no screenshot overwrites another", () => {
  const names = [...PUBLIC_PAGES, ...LAYOUT_PAGES].map((one) => one.name);
  const repeated = names.filter((name, at) => names.indexOf(name) !== at);
  expect(repeated, "page names used more than once").toEqual([]);
});

test("every listed page fits the screen, keeps controls apart and text at 14px or more", async ({
  page,
}, info) => {
  test.setTimeout(900_000);
  page.on("pageerror", (error) => {
    throw error;
  });
  const project = info.project.name;
  await page.setViewportSize(
    project === "phone" ? { width: 360, height: 780 } : { width: 1440, height: 900 },
  );
  await freshAddress(page);
  watchRequests(page);

  for (const listed of PUBLIC_PAGES) {
    for (const language of LANGUAGES) {
      await checkPage(page, project, language, listed, listed.path);
    }
  }

  const created = await createEvent(page, project);
  await fillShop(page, created);
  const draftIds: LayoutIds = {
    ...created,
    joinCode: "",
    ticketId: "",
    campaignId: "",
    playerId: "",
  };
  for (const listed of LAYOUT_PAGES.filter((one) => one.phase === "draft")) {
    for (const language of LANGUAGES) {
      await checkPage(page, project, language, listed, listed.path(draftIds));
    }
  }
  for (const language of LANGUAGES) {
    await checkDialog(page, project, language, created);
  }

  const ids = await startAndFill(page, created);
  for (const listed of LAYOUT_PAGES.filter((one) => one.phase !== "draft")) {
    for (const language of LANGUAGES) {
      await checkPage(page, project, language, listed, listed.path(ids));
    }
  }
});
