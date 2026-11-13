import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { PASSWORD, codeFor, freshAddress, lastCodeFor } from "#e2e/mail.ts";
import { SPLIT_CODES_FILE, SPLIT_CONSOLE_ORIGIN, SPLIT_WEB_ORIGIN } from "#e2e/paths.ts";

/**
 * The console on its own host (T-810d, ADR-720 to ADR-722), desktop and phone, English and Arabic, on the second server
 * pair (`CONSOLE_ORIGIN` set; playwright.config.ts): the public host sends the console there, the console host sends
 * every dashboard page back, each host keeps its own `__Host-` session cookie, and the public host never passes a
 * console call on, whatever session its page holds. Every other spec runs with no console host, as before.
 */
const SESSION = "__Host-qs_session";

const adminOf = (info: TestInfo) => `console.${info.project.name}@questify.test`;

/** The session cookie the browser holds for exactly this host (a `__Host-` cookie belongs to one host only). */
async function sessionOn(page: Page, origin: string): Promise<string | undefined> {
  const host = new URL(origin).hostname;
  return (await page.context().cookies()).find(
    (cookie) => cookie.name === SESSION && cookie.domain === host,
  )?.value;
}

/** The two sign-in steps on one host's sign-in page, with the code from the second pair's mailbox. */
async function signInOn(page: Page, origin: string, email: string): Promise<void> {
  const previous = lastCodeFor(email, SPLIT_CODES_FILE);
  await page.goto(`${origin}/en/sign-in`);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Continue" }).click();
  await page
    .getByRole("textbox", { name: "Sign-in code" })
    .fill(await codeFor(email, previous, SPLIT_CODES_FILE));
  await page.getByRole("button", { name: "Sign in" }).click();
}

/** What a page's own fetch of a console path answers, sent by the browser with that host's cookie and Origin. */
const consoleStatusFrom = (page: Page) =>
  page.evaluate(async () => (await fetch("/v1/admin/activation-requests")).status);

async function expectNoSidewaysScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

test("the console lives on its own host with its own session, and the public host never reaches it", async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  await freshAddress(page);
  const admin = adminOf(info);

  // An old /console address on the public host lands on the console host, where this browser is not signed in yet.
  await page.goto(`${SPLIT_WEB_ORIGIN}/en/console`);
  await expect(page).toHaveURL(`${SPLIT_CONSOLE_ORIGIN}/en/sign-in`);

  await signInOn(page, SPLIT_CONSOLE_ORIGIN, admin);
  await expect(page).toHaveURL(`${SPLIT_CONSOLE_ORIGIN}/en/console`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expectNoSidewaysScroll(page);
  const consoleSession = await sessionOn(page, SPLIT_CONSOLE_ORIGIN);
  expect(consoleSession).toBeDefined();
  expect(await sessionOn(page, SPLIT_WEB_ORIGIN)).toBeUndefined();
  expect(await consoleStatusFrom(page)).toBe(200);

  // The same admin signed in on the public host holds a second, separate session that gets nothing of the console.
  await signInOn(page, SPLIT_WEB_ORIGIN, admin);
  await expect(page).toHaveURL(`${SPLIT_WEB_ORIGIN}/en`);
  const publicSession = await sessionOn(page, SPLIT_WEB_ORIGIN);
  expect(publicSession).toBeDefined();
  expect(publicSession).not.toBe(consoleSession);
  expect(await consoleStatusFrom(page)).toBe(404);

  // A dashboard page on the console host goes back to the public host.
  await page.goto(`${SPLIT_CONSOLE_ORIGIN}/en/organizers`);
  await expect(page).toHaveURL(new RegExp(`^${SPLIT_WEB_ORIGIN}/en/organizers`));
});

test("in Arabic the console host opens the console, and the public host sends its console address there", async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  await freshAddress(page);
  await signInOn(page, SPLIT_CONSOLE_ORIGIN, adminOf(info));
  await expect(page).toHaveURL(`${SPLIT_CONSOLE_ORIGIN}/en/console`);

  await page.goto(`${SPLIT_CONSOLE_ORIGIN}/ar`);
  await expect(page).toHaveURL(`${SPLIT_CONSOLE_ORIGIN}/ar/console`);
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expectNoSidewaysScroll(page);

  await page.goto(`${SPLIT_WEB_ORIGIN}/ar/console/tickets?x=1`);
  await expect(page).toHaveURL(`${SPLIT_CONSOLE_ORIGIN}/ar/console/tickets?x=1`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
});
