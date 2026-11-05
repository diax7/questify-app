import { expect, test, type Page } from "@playwright/test";
import { openBuilder } from "#e2e/builder.ts";
import { makeAdmin } from "#e2e/hosts.ts";
import { CONSOLE_ORIGIN, WEB_ORIGIN } from "#e2e/paths.ts";

/**
 * The console on its own host (T-810d, ADR-720 to ADR-722), desktop and phone, English and Arabic: the public host sends
 * the console there, the console host sends every dashboard page back, each host keeps its own session cookie, and the
 * public host never passes a console call on, whatever session its page holds.
 */
const SESSION = "__Host-qs_session";

/** The session cookie the browser holds for exactly this host (each `__Host-` cookie belongs to one host only). */
async function sessionOn(page: Page, origin: string): Promise<string | undefined> {
  const host = new URL(origin).hostname;
  return (await page.context().cookies()).find(
    (cookie) => cookie.name === SESSION && cookie.domain === host,
  )?.value;
}

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
  await openBuilder(page, info.project.name);
  const eventId = page.url().split("/").at(-2) ?? "";
  const publicSession = await sessionOn(page, WEB_ORIGIN);
  expect(publicSession).toBeDefined();

  // The console on the public host goes to the console host, where this browser is not signed in yet.
  await page.goto("/en/console");
  await expect(page).toHaveURL(`${CONSOLE_ORIGIN}/en/sign-in`);
  await expect(page.getByRole("button", { name: "Continue" })).toBeVisible();

  await makeAdmin(page, eventId);
  const consoleSession = await sessionOn(page, CONSOLE_ORIGIN);
  expect(consoleSession).toBeDefined();
  expect(consoleSession).not.toBe(publicSession);
  expect(await sessionOn(page, WEB_ORIGIN)).toBe(publicSession);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expectNoSidewaysScroll(page);

  // The same admin's public-host session, from a public page, gets nothing of the console.
  await page.goto(`${WEB_ORIGIN}/en`);
  const fromPublic = await page.evaluate(async () => {
    const response = await fetch("/v1/admin/activation-requests", { credentials: "same-origin" });
    return response.status;
  });
  expect(fromPublic).toBe(404);

  // A dashboard page on the console host goes back to the public host.
  await page.goto(`${CONSOLE_ORIGIN}/en/organizers`);
  await expect(page).toHaveURL(new RegExp(`^${WEB_ORIGIN}/en/organizers`));
});

test("in Arabic the console host opens the console, and the public host sends its console address there", async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  await openBuilder(page, info.project.name);
  const eventId = page.url().split("/").at(-2) ?? "";
  await makeAdmin(page, eventId);

  await page.goto(`${CONSOLE_ORIGIN}/ar`);
  await expect(page).toHaveURL(`${CONSOLE_ORIGIN}/ar/console`);
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expectNoSidewaysScroll(page);

  await page.goto(`${WEB_ORIGIN}/ar/console/tickets`);
  await expect(page).toHaveURL(`${CONSOLE_ORIGIN}/ar/console/tickets`);
  await expect(page.getByRole("heading", { name: "التذاكر", level: 1 })).toBeVisible();
});
