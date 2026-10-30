import { expect, test, type Page } from "@playwright/test";
import { readBrokenImages } from "#e2e/layout.ts";
import { codeFor, freshAddress } from "#e2e/mail.ts";
import { openMenu } from "#e2e/nav.ts";
import { CONTROL_PORT } from "#e2e/paths.ts";

/**
 * Moving around the dashboard stays inside the app (T-599c): a link between its pages changes the page in place, with
 * the top bar and the navigation staying on screen, and never loads the document again. The top bar shows the Questify
 * logo, and the language switch and Sign out are icons that name themselves and explain themselves on hover.
 */
const PASSWORD = "an organizer's own pass phrase";
const MARKER = "questifyDocumentMarker";
const SHELL_MARKER = "questifyShellMarker";

/** Writes a mark into the open document; it survives a link that changes the page in place, never a full load. */
async function markDocument(page: Page): Promise<void> {
  await page.evaluate((name) => Object.assign(window, { [name]: true }), MARKER);
}

/** Marks the top bar's element; it survives while the shell stays mounted, and is new when a layout swaps the shell. */
async function markShell(page: Page): Promise<void> {
  await page.evaluate(
    (name) => Object.assign(document.querySelector("header") ?? {}, { [name]: true }),
    SHELL_MARKER,
  );
}

/** Fails when the shell was mounted again: the top bar is not the element marked. */
async function expectSameShell(page: Page, where: string): Promise<void> {
  const marked = await page.evaluate(
    (name) => Reflect.get(document.querySelector("header") ?? {}, name) === true,
    SHELL_MARKER,
  );
  expect(marked, `${where}: the shell was mounted again while the page changed`).toBe(true);
}

/** Fails when the document the person is looking at is not the one marked: something loaded the page again. */
async function expectSameDocument(page: Page, where: string): Promise<void> {
  const marked = await page.evaluate((name) => Reflect.get(window, name) === true, MARKER);
  expect(marked, `${where}: the page was loaded again instead of changing in place`).toBe(true);
}

/** Signs up a new organizer and lands on the home page. */
async function signUp(page: Page, project: string): Promise<void> {
  const email = `nav.${project}.${Date.now()}.${Math.floor(Math.random() * 1e6)}@riyadh.test`;
  await freshAddress(page);
  await page.goto("/en/sign-up");
  await page.getByLabel("Organizer name", { exact: true }).fill("Najd Nav Co");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("New password", { exact: true }).fill(PASSWORD);
  await page.getByLabel("Type the new password again", { exact: true }).fill(PASSWORD);
  await page.getByLabel("I accept the organizer terms").check();
  await page.getByLabel("I accept the data processing agreement").check();
  await page.getByLabel("I accept the content rules").check();
  await page.getByRole("button", { name: "Create the account" }).click();
  await page.getByRole("textbox", { name: "Sign-in code" }).fill(await codeFor(email));
  await page.getByRole("button", { name: "Create the account" }).click();
  await expect(page).toHaveURL(/\/en$/);
}

/** Creates a draft event from the events list and returns its id (the form ends with a full load). */
async function createDraftEvent(page: Page): Promise<string> {
  await page.getByRole("link", { name: "Events" }).click();
  await page.getByRole("link", { name: "New event" }).click();
  await page.getByLabel("Name in Arabic", { exact: true }).fill("ملتقى التنقل");
  await page.getByLabel("Name in English", { exact: true }).fill("Nav Meetup");
  await page.getByLabel("Starts", { exact: true }).fill("2030-11-01T09:00");
  await page.getByLabel("Ends", { exact: true }).fill("2030-11-01T17:00");
  await page.getByRole("button", { name: "Create event" }).click();
  await expect(page.getByRole("button", { name: "Save changes" })).toBeVisible();
  return /\/events\/([0-9a-f-]{36})/.exec(page.url())?.[1] ?? "";
}

/**
 * Opens a link of the navigation by its name (on a phone the Menu sheet first), waits for the page at `path` to be
 * drawn (the loading skeleton has no heading), and checks the document is still the marked one.
 */
async function goTo(
  page: Page,
  link: string | RegExp,
  path: RegExp,
  { newShell = false }: Readonly<{ newShell?: boolean }> = {},
): Promise<void> {
  await openMenu(page);
  const item = page
    .getByRole("navigation", { name: "Navigation" })
    .getByRole("link", typeof link === "string" ? { name: link, exact: true } : { name: link });
  await item.click();
  await expect(page).toHaveURL(path);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expectSameDocument(page, `after opening ${link}`);
  if (newShell) {
    await markShell(page);
  } else {
    await expectSameShell(page, `after opening ${link}`);
  }
  await openMenu(page);
  await expect(item).toHaveAttribute("aria-current", "page");
  const menu = page.getByRole("button", { name: "Menu" });
  if (await menu.isVisible()) {
    await page.keyboard.press("Escape");
    await expect(menu).toHaveAttribute("aria-expanded", "false");
  }
}

const BRAND = /^Questify( Dashboard| Console)?$/;

test("moving between the dashboard's pages never loads the document again", async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  await signUp(page, info.project.name);
  const eventId = await createDraftEvent(page);
  await markDocument(page);
  await markShell(page);

  await goTo(page, "Quests", /\/events\/[^/]+\/quests$/);
  // A page change names the page in the tab title (which a screen reader's route announcement reads); on a desktop the
  // heading takes focus, on a phone focus stays on Menu where the sheet put it.
  const heading = page.getByRole("heading", { level: 1 });
  const name = (await heading.innerText()).trim();
  await expect(page).toHaveTitle(new RegExp(`^${name} · `));
  if (info.project.name === "desktop") {
    await expect(heading).toBeFocused();
  }
  await goTo(page, "Rewards", /\/events\/[^/]+\/rewards$/);
  await expect(page).not.toHaveTitle(new RegExp(`^${name} · `));
  await goTo(page, "Event souvenirs", /\/events\/[^/]+\/souvenirs$/);
  await goTo(page, "Flagged activity", /\/events\/[^/]+\/flags$/);
  await goTo(page, "Event overview", /\/events\/[0-9a-f-]{36}$/);
  // The team page is in the organizer's workspace layout, whose shell is not the event's: it is new here, then stays.
  await goTo(page, "Team", /\/organizers\/[^/]+\/team$/, { newShell: true });
  await goTo(page, "Events", /\/organizers\/[^/]+\/events$/);

  // A link inside a page (the events list opens its event) and the logo link of the top bar.
  await page.getByRole("link", { name: "Nav Meetup" }).click();
  await expect(page.getByRole("button", { name: "Save changes" })).toBeVisible();
  await expectSameDocument(page, "after opening an event from the list");
  await page.getByRole("banner").getByRole("link", { name: BRAND }).click();
  await expect(page).toHaveURL(/\/en$/);
  await expect(page.getByRole("heading", { name: "Home", level: 1 })).toBeVisible();
  await expectSameDocument(page, "after the logo link");
  await openMenu(page);
  await page.getByRole("link", { name: "My account" }).filter({ visible: true }).click();
  await expect(page.getByRole("heading", { name: "My account", level: 1 })).toBeVisible();
  await expectSameDocument(page, "after My account");

  // The console shares the document too: Home links to it for an admin, and its navigation stays put.
  const made = await page.request.post(`http://127.0.0.1:${CONTROL_PORT}/make-admin`, {
    data: { eventId },
  });
  expect(made.status()).toBe(204);
  await page.getByRole("banner").getByRole("link", { name: BRAND }).click();
  await page.getByRole("link", { name: "Questify console" }).click();
  await expect(page).toHaveURL(/\/en\/console$/);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expectSameDocument(page, "after opening the console");
  await markShell(page);
  await goTo(page, "Ranking seasons", /\/en\/console\/seasons$/);
  await goTo(page, /^Content/, /\/en\/console\/content$/);

  // The language switch changes the page's language and direction in place, too.
  await page.getByRole("link", { name: "Switch to العربية" }).click();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page).toHaveURL(/\/ar\/console\/content$/);
  await expectSameDocument(page, "after the language switch");
  await expect(page.getByRole("link", { name: "التبديل إلى English" })).toBeVisible();
});

test("the top bar shows the logo, with the language switch and Sign out as named icons", async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  await signUp(page, info.project.name);
  const bar = page.getByRole("banner");

  const logo = bar.getByRole("img", { name: "Questify" });
  await expect(logo).toBeVisible();
  expect(await logo.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
  await expect(bar).not.toContainText("Questify dashboard");
  expect(await readBrokenImages(page)).toEqual([]);

  const language = bar.getByRole("link", { name: "Switch to العربية" });
  await expect(language).toBeVisible();
  await expect(language).not.toContainText("العربية");
  await openMenu(page);
  const signOut = page.getByRole("button", { name: "Sign out" }).filter({ visible: true });
  await expect(signOut).toBeVisible();

  if (info.project.name === "desktop") {
    for (const [control, words] of [
      [language, "Switch to العربية"],
      [signOut, "Sign out"],
    ] as const) {
      await control.hover();
      await expect
        .poll(() => control.evaluate((element) => getComputedStyle(element, "::after").opacity))
        .toBe("1");
      const tip = await control.evaluate((element) => getComputedStyle(element, "::after").content);
      expect(tip).toBe(`"${words}"`);
    }
  }

  await page.goto("/ar");
  await expect(bar.getByRole("link", { name: "التبديل إلى English" })).toBeVisible();
  await openMenu(page);
  await expect(
    page.getByRole("button", { name: "تسجيل الخروج" }).filter({ visible: true }),
  ).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
});

test("on a phone a tap on any link in the menu sheet closes it and puts focus back on Menu", async ({
  page,
}, info) => {
  test.skip(info.project.name !== "phone", "The menu sheet is the phone's navigation");
  test.setTimeout(120_000);
  await signUp(page, info.project.name);
  await page.getByRole("link", { name: "Events" }).click();
  await expect(page).toHaveURL(/\/organizers\/[^/]+\/events$/);
  const menu = page.getByRole("button", { name: "Menu" });
  const links = page.getByRole("navigation", { name: "Navigation" });

  // The open page's own link changes nothing in the address, and still closes the sheet.
  await openMenu(page);
  await links.getByRole("link", { name: "Events", exact: true }).click();
  await expect(menu).toHaveAttribute("aria-expanded", "false");
  await expect(menu).toBeFocused();

  // A link to another page closes it when the page changes, the shell staying where it is.
  await markDocument(page);
  await openMenu(page);
  await links.getByRole("link", { name: "Team", exact: true }).click();
  await expect(page).toHaveURL(/\/organizers\/[^/]+\/team$/);
  await expectSameDocument(page, "after opening Team");
  await expect(menu).toHaveAttribute("aria-expanded", "false");
  await expect(menu).toBeFocused();
});

test("a page of players names Questify without the dashboard, and still shows the logo", async ({
  page,
}) => {
  await freshAddress(page);
  await page.goto("/en/contact");
  const bar = page.getByRole("banner");
  await expect(bar.getByRole("img", { name: "Questify" })).toBeVisible();
  await expect(bar).not.toContainText("Dashboard");
  await expect(bar.getByRole("link", { name: "Questify", exact: true })).toBeVisible();
  expect(await readBrokenImages(page)).toEqual([]);
});
