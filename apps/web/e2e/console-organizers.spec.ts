import { expect, test, type Browser, type Page, type TestInfo } from "@playwright/test";
import { openBuilder } from "#e2e/builder.ts";
import { CONTROL_PORT } from "#e2e/paths.ts";

const CONTROL = `http://127.0.0.1:${CONTROL_PORT}`;
const REASON = "Prize desk reported for fraud";

/**
 * The console's organizers, suspension and support access (T-701), desktop and phone, English and Arabic. Two
 * organizers: the admin's own (its owner is made a platform admin) and another one, built in a second browser, whose
 * owner sees the suspension and its reason but never the support access.
 */

/** The organizer and event ids of the builder page a run just opened (`…/organizers/{id}/events/{id}/quests`). */
function idsOf(page: Page): { organizerId: string; eventId: string } {
  const parts = new URL(page.url()).pathname.split("/");
  return { organizerId: parts[3] ?? "", eventId: parts[5] ?? "" };
}

async function asAdmin(page: Page, project: string): Promise<void> {
  await openBuilder(page, project);
  const { eventId } = idsOf(page);
  expect((await page.request.post(`${CONTROL}/make-admin`, { data: { eventId } })).status()).toBe(
    204,
  );
}

/** Another organizer in its own browser: its owner's page and its ids. */
async function otherOrganizer(browser: Browser, info: TestInfo) {
  const context = await browser.newContext({
    baseURL: info.project.use.baseURL ?? "http://localhost:3100",
  });
  const page = await context.newPage();
  await openBuilder(page, info.project.name);
  return { context, page, ...idsOf(page) };
}

async function expectNoSidewaysScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

test("an admin suspends an organizer, its owner reads the reason, and the admin reactivates it", async ({
  page,
  browser,
}, info) => {
  test.setTimeout(180_000);
  const other = await otherOrganizer(browser, info);
  await asAdmin(page, info.project.name);
  await page.goto(`/en/console/organizers/${other.organizerId}`);
  await expect(page.getByRole("heading", { name: "Najd Quests Co", level: 1 })).toBeVisible();
  await expect(page.getByText("Not suspended.")).toBeVisible();
  const suspend = page.getByRole("button", { name: "Suspend organizer" });
  await expect(suspend).toBeDisabled();
  await page.getByLabel("Reason (the organizer sees it, players do not)").fill(REASON);
  await suspend.click();
  await expect(page.getByText("Suspend Najd Quests Co?", { exact: false })).toBeVisible();
  await page.getByRole("alert").getByRole("button", { name: "Suspend organizer" }).click();
  await expect(page.getByRole("status")).toHaveText("Suspended.");
  await expect(page.getByText(`: ${REASON}`, { exact: false })).toBeVisible();
  await expectNoSidewaysScroll(page);

  await other.page.goto(`/en/organizers/${other.organizerId}/events/${other.eventId}`);
  await expect(other.page.getByText(`Questify paused your organizer: ${REASON}`)).toBeVisible();

  await page.getByRole("button", { name: "Reactivate" }).click();
  await page.getByRole("alert").getByRole("button", { name: "Reactivate" }).click();
  await expect(page.getByRole("status")).toHaveText("Reactivated.");
  await other.page.reload();
  await expect(other.page.getByText("Questify paused your organizer")).toHaveCount(0);
  await other.context.close();
});

test("an admin opens an event as support and lands in its dashboard; the owner sees nothing", async ({
  page,
  browser,
}, info) => {
  test.setTimeout(180_000);
  const other = await otherOrganizer(browser, info);
  await asAdmin(page, info.project.name);
  await page.goto(`/en/console/events/${other.eventId}`);
  await expect(page.getByText("No one has support access now.")).toBeVisible();
  await page.getByLabel("Why you need access").fill("Owner asked for help with quests");
  await page.getByRole("button", { name: "Open as support" }).click();
  await page.getByRole("alert").getByRole("button", { name: "Open as support" }).click();
  await expect(page).toHaveURL(
    new RegExp(`/en/organizers/${other.organizerId}/events/${other.eventId}$`),
  );
  await expect(page.getByText("You are in this event as Questify support until")).toBeVisible();
  await expectNoSidewaysScroll(page);

  await other.page.goto(`/en/organizers/${other.organizerId}/events/${other.eventId}`);
  await expect(other.page.getByText("as Questify support")).toHaveCount(0);

  await page.goto(`/en/console/events/${other.eventId}`);
  await page.getByRole("button", { name: "End", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Support access ended.");
  await expect(page.getByText("No one has support access now.")).toBeVisible();
  await other.context.close();
});

test("in Arabic the organizers list reads right to left and finds an organizer by name", async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  await asAdmin(page, info.project.name);
  await page.goto("/ar/console/organizers");
  await expect(page.getByRole("heading", { name: "الجهات المنظِّمة", level: 1 })).toBeVisible();
  await page.getByLabel("الاسم أو المعرّف أو بريد المالك").fill("Najd Quests");
  await page.getByRole("button", { name: "بحث" }).click();
  await expect(page.getByRole("link", { name: "Najd Quests Co" }).first()).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expectNoSidewaysScroll(page);
});

test("a person who is not an admin gets nothing from the console's organizers", async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  await openBuilder(page, info.project.name);
  expect((await page.request.get("/v1/admin/organizers")).status()).toBe(404);
  const { eventId } = idsOf(page);
  // Without the dashboard's Origin the write stops at the cross-site check (403); either way nothing opens.
  const opened = await page.request.post(`/v1/admin/events/${eventId}/support`, {
    data: { reason: REASON },
  });
  expect([403, 404]).toContain(opened.status());
});
