import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { openBuilder } from "#e2e/builder.ts";
import { CONTROL_PORT } from "#e2e/paths.ts";

const CONTROL = `http://127.0.0.1:${CONTROL_PORT}`;

async function expectNoSidewaysScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

/** A new draft with dates set and nothing else: two items done, five to check, two needed. */
async function openOverview(page: Page, project: string) {
  await openBuilder(page, project);
  const eventUrl = page.url().replace(/\/quests$/, "");
  await page.goto(eventUrl);
  return { eventUrl, eventId: eventUrl.split("/").at(-1) ?? "" };
}

/** The cards of one grid row are as tall as the tallest: compare the cards that start at the same height. */
async function expectEqualHeightsPerRow(page: Page, testId: string): Promise<void> {
  const boxes = await page
    .getByTestId(testId)
    .evaluateAll((nodes) =>
      nodes.map((node) => node.closest("section")?.getBoundingClientRect() ?? null),
    );
  const rows = new Map<number, number[]>();
  for (const box of boxes) {
    if (box !== null) {
      const row = rows.get(Math.round(box.top)) ?? [];
      row.push(Math.round(box.height));
      rows.set(Math.round(box.top), row);
    }
  }
  for (const heights of rows.values()) {
    expect(new Set(heights).size, heights.join(",")).toBe(1);
  }
}

/**
 * The owner's go-live checklist on the Overview (T-618, FR-1845), in Arabic: counts, blocking items first, a missing
 * rehearsal shown as missing, each item linked to the page that fixes it, nothing blocked and nothing sideways.
 */
test("the Overview lists what is ready, what to check and what is needed, with a fix link each", async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  const { eventUrl } = await openOverview(page, info.project.name);
  const card = page.getByRole("region", { name: "قبل الانطلاق" });
  await expect(card).toBeVisible();
  await expect(card.getByTestId("readiness-count-done")).toContainText("مكتمل: 2");
  await expect(card.getByTestId("readiness-count-warning")).toContainText("للمراجعة: 5");
  await expect(card.getByTestId("readiness-count-blocking")).toContainText("مطلوب: 2");

  const items = card.getByTestId("readiness-item");
  await expect(items).toHaveCount(9);
  await expect(items.first()).toHaveAttribute("data-status", "blocking");
  await expect(items.last()).toHaveAttribute("data-status", "done");
  const rehearsal = card.locator('[data-key="rehearsal"]');
  await expect(rehearsal).toContainText("تجربة اللعب");
  await expect(rehearsal).toContainText("ناقصة");
  await expect(rehearsal).toHaveAttribute("data-status", "warning");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expectNoSidewaysScroll(page);

  await card.getByRole("link", { name: "إصلاح: مهام" }).click();
  await expect(page).toHaveURL(/\/quests$/);
  await page.goto(eventUrl);
  await card.getByRole("link", { name: "إصلاح: تجربة اللعب" }).click();
  await expect(page).toHaveURL(/#rehearsal-title$/);
  await expect(page.getByRole("heading", { name: "التجربة", level: 2 })).toBeVisible();
});

test("the same checklist reads in English, and the guided setup's last step carries it", async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  const { eventUrl } = await openOverview(page, info.project.name);
  await page.goto(eventUrl.replace("/ar/", "/en/"));
  const card = page.getByRole("region", { name: "Before you go live" });
  await expect(card.locator('[data-key="rehearsal"]')).toContainText("Rehearsal run");
  await expect(card.locator('[data-key="rehearsal"]')).toContainText("Missing");
  await expect(card.locator('[data-key="activation"]')).toContainText("Not requested");
  await expect(card.locator('[data-key="dates"]')).toHaveAttribute("data-status", "done");
  await expect(card.getByRole("link", { name: "Fix: Activation" })).toHaveAttribute(
    "href",
    /#activation-title$/,
  );
  await expect(card.getByRole("link", { name: "Open: Dates" })).toBeVisible();
  await expectNoSidewaysScroll(page);

  await page.goto(`${eventUrl.replace("/ar/", "/en/")}/setup?step=review`);
  await expect(
    page.getByRole("region", { name: "Before you go live" }).getByTestId("readiness-item"),
  ).toHaveCount(9);
});

/**
 * The console's Readiness list (T-618): the events that start within 14 days with the checklist their owner reads, as
 * equal cards; platform admins only.
 */
async function asAdminWithEventSoon(page: Page, project: string): Promise<string> {
  const { eventId } = await openOverview(page, project);
  expect((await page.request.post(`${CONTROL}/event-soon`, { data: { eventId } })).status()).toBe(
    204,
  );
  expect((await page.request.post(`${CONTROL}/make-admin`, { data: { eventId } })).status()).toBe(
    204,
  );
  return eventId;
}

test("in English an admin reads the events starting soon with what is still open", async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  const eventId = await asAdminWithEventSoon(page, info.project.name);
  await page.goto("/en/console/readiness");
  await expect(page.getByRole("heading", { name: "Readiness", level: 1 })).toBeVisible();
  const open = page.locator(`a[href$="/console/events/${eventId}"]`);
  await expect(open).toBeVisible();
  const card = open.locator("xpath=ancestor::article[1]");
  await expect(card.getByTestId("readiness-counts")).toContainText("Needed: 2");
  await expect(card.getByTestId("readiness-counts")).toContainText("To check: 5");
  await expect(card.getByTestId("readiness-counts")).toContainText("Ready: 2");
  await expect(card.locator('[data-key="rehearsal"]')).toContainText("Missing");
  await expect(card.locator('[data-key="dates"]')).toHaveCount(0);
  await expectEqualHeightsPerRow(page, "readiness-counts");
  await expectNoSidewaysScroll(page);
  await open.click();
  await expect(page).toHaveURL(new RegExp(`/console/events/${eventId}$`));
});

test("in Arabic the list reads right to left without sideways scrolling", async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  const eventId = await asAdminWithEventSoon(page, info.project.name);
  await page.goto("/ar/console/readiness");
  await expect(page.getByRole("heading", { name: "الجاهزية", level: 1 })).toBeVisible();
  const card = page
    .locator(`a[href$="/console/events/${eventId}"]`)
    .locator("xpath=ancestor::article[1]");
  await expect(card.getByTestId("readiness-counts")).toContainText("مطلوب: 2");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expectNoSidewaysScroll(page);
});

test("two events with one name are two cards and no repeated landmark", async ({
  page,
  browser,
}, info) => {
  test.setTimeout(180_000);
  const { eventId: first } = await openOverview(page, info.project.name);
  expect(
    (await page.request.post(`${CONTROL}/event-soon`, { data: { eventId: first } })).status(),
  ).toBe(204);
  // A second owner needs a browser of their own; both events are named alike by `openBuilder`.
  const admin = await browser.newContext({ baseURL: info.project.use.baseURL ?? "" });
  try {
    const other = await admin.newPage();
    const second = await asAdminWithEventSoon(other, info.project.name);
    await other.goto("/en/console/readiness");
    await expect(other.getByRole("heading", { name: "Readiness", level: 1 })).toBeVisible();
    for (const eventId of [first, second]) {
      const card = other
        .locator(`a[href$="/console/events/${eventId}"]`)
        .locator("xpath=ancestor::article[1]");
      await expect(card.getByTestId("readiness-counts")).toBeVisible();
    }
    // The cards are articles named by their heading, not regions: two with the same name must not trip axe.
    const result = await new AxeBuilder({ page: other }).withRules(["landmark-unique"]).analyze();
    expect(result.violations.map((one) => one.id)).toEqual([]);
  } finally {
    await admin.close();
  }
});

test("a person who is not an admin does not get the list", async ({ page }, info) => {
  test.setTimeout(120_000);
  await openOverview(page, info.project.name);
  expect((await page.request.get("/v1/admin/readiness")).status()).toBe(404);
});
