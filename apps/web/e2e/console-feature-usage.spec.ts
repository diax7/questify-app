import { expect, test, type Page } from "@playwright/test";
import { openBuilder } from "#e2e/builder.ts";
import { CONTROL_PORT } from "#e2e/paths.ts";

const WEB = "http://localhost:3100";
const CONTROL = `http://127.0.0.1:${CONTROL_PORT}`;

/**
 * The console's feature usage (T-714, FR-1839), desktop and phone, English and Arabic. The organizer a run just created
 * has one draft event; Questify switches Cheers off for it, and the page shows Cheers off with its cause, the other
 * features on in that one event, and nothing used yet. Searching by the organizer's slug finds its card.
 */
async function asAdmin(
  page: Page,
  project: string,
): Promise<{ organizerId: string; slug: string }> {
  await openBuilder(page, project);
  const parts = new URL(page.url()).pathname.split("/");
  const organizerId = parts[3] ?? "";
  const eventId = parts[5] ?? "";
  expect((await page.request.post(`${CONTROL}/make-admin`, { data: { eventId } })).status()).toBe(
    204,
  );
  const detail = await page.request.get(`/v1/admin/organizers/${organizerId}`);
  expect(detail.status()).toBe(200);
  const { organizer } = (await detail.json()) as { organizer: { slug: string } };
  return { organizerId, slug: organizer.slug };
}

async function cheersOff(page: Page, organizerId: string): Promise<void> {
  const answer = await page.request.put(`/v1/admin/organizers/${organizerId}/features/cheers`, {
    data: { enabled: false },
    headers: { origin: WEB },
  });
  expect(answer.status()).toBe(204);
}

async function expectNoSidewaysScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

test("in English an admin finds an organizer and reads which features are on and used", async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  const { organizerId, slug } = await asAdmin(page, info.project.name);
  await cheersOff(page, organizerId);
  await page.goto("/en/console/feature-usage");
  await expect(page.getByRole("heading", { name: "Feature usage", level: 1 })).toBeVisible();
  await page.getByLabel("Organizer name or slug").fill(slug);
  await page.getByRole("button", { name: "Search" }).click();

  const card = page.locator(`[data-organizer="${organizerId}"]`);
  await expect(card).toBeVisible();
  await expect(card.getByText("Events counted: 1")).toBeVisible();
  const cheers = card.locator('[data-feature="cheers"]');
  await expect(cheers).toHaveAttribute("data-state", "off");
  await expect(cheers).toContainText("Off");
  await expect(cheers).toContainText("Override: off");
  const shop = card.locator('[data-feature="shop"]');
  await expect(shop).toHaveAttribute("data-state", "on");
  await expect(shop).toContainText("Events with it on: 1 of 1 · No event uses it yet");
  await expect(card.locator('[data-feature="ranking"]')).toContainText("Events with it on: 1 of 1");
  await expect(card.locator('[data-feature="ranking"]')).not.toContainText("Events using it");
  await expect(card.locator('[data-feature="bigScreen"]')).toContainText(
    "Events it is unlocked for: 0 of 1",
  );
  await expect(card.getByRole("link", { name: /./ }).first()).toHaveAttribute(
    "href",
    `/en/console/organizers/${organizerId}`,
  );
  await expectNoSidewaysScroll(page);
});

test("in Arabic the page reads right to left with the same facts", async ({ page }, info) => {
  test.setTimeout(120_000);
  const { organizerId, slug } = await asAdmin(page, info.project.name);
  await cheersOff(page, organizerId);
  await page.goto("/ar/console/feature-usage");
  await expect(page.getByRole("heading", { name: "استخدام الميزات", level: 1 })).toBeVisible();
  await page.getByLabel("اسم الجهة أو معرّفها").fill(slug);
  await page.getByRole("button", { name: "بحث" }).click();

  const card = page.locator(`[data-organizer="${organizerId}"]`);
  await expect(card).toBeVisible();
  const cheers = card.locator('[data-feature="cheers"]');
  await expect(cheers).toHaveAttribute("data-state", "off");
  await expect(cheers).toContainText("استثناء: متوقفة");
  await expect(card.locator('[data-feature="shop"]')).toContainText(
    "الفعاليات التي تعمل فيها: 1 من 1",
  );
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expectNoSidewaysScroll(page);
});

test("a person who is not an admin does not get the page's data", async ({ page }, info) => {
  test.setTimeout(120_000);
  await openBuilder(page, info.project.name);
  const answer = await page.request.get("/v1/admin/feature-usage");
  expect(answer.status()).toBe(404);
});
