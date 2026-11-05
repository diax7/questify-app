import { expect, test, type Page } from "@playwright/test";
import { openBuilder } from "#e2e/builder.ts";
import { makeAdmin } from "#e2e/hosts.ts";

/**
 * The console's Usage view (T-609, FR-1730, ADR-394), desktop and phone, English and Arabic. The organizer a run just
 * created is the newest, so it is the first card; its event is a new draft with no players, so every figure is 0.
 */

async function asAdmin(page: Page, project: string): Promise<void> {
  await openBuilder(page, project);
  const eventId = page.url().split("/").at(-2) ?? "";
  await makeAdmin(page, eventId);
}

async function expectNoSidewaysScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

test("in English an admin reads an organizer's figures and opens its events", async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  await asAdmin(page, info.project.name);
  await page.goto("/en/console/usage");
  await expect(page.getByRole("heading", { name: "Usage", level: 1 })).toBeVisible();
  const card = page.getByTestId("usage-organizer").first();
  await expect(card.getByText("Players", { exact: true })).toBeVisible();
  await expect(card.getByText("Invitations sent", { exact: true })).toBeVisible();
  await expect(card.getByText("Alert emails sent", { exact: true })).toBeVisible();
  await card.getByRole("button", { name: "Show events" }).click();
  const events = card.getByTestId("usage-events");
  await expect(events.getByText("Draft", { exact: true })).toBeVisible();
  await expect(events).toContainText("Players: 0 · Invitations sent: 0 · Alert emails: 0");
  await card.getByRole("button", { name: "Hide events" }).click();
  await expect(events).toHaveCount(0);
  await expectNoSidewaysScroll(page);
});

test("in Arabic the page and its events read right to left", async ({ page }, info) => {
  test.setTimeout(120_000);
  await asAdmin(page, info.project.name);
  await page.goto("/ar/console/usage");
  await expect(page.getByRole("heading", { name: "الاستخدام", level: 1 })).toBeVisible();
  const card = page.getByTestId("usage-organizer").first();
  await card.getByRole("button", { name: "عرض الفعاليات" }).click();
  await expect(card.getByTestId("usage-events")).toContainText("اللاعبون: 0");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expectNoSidewaysScroll(page);
});

test("a person who is not an admin does not get the page's data", async ({ page }, info) => {
  test.setTimeout(120_000);
  await openBuilder(page, info.project.name);
  const answer = await page.request.get("/v1/admin/usage");
  expect(answer.status()).toBe(404);
});
