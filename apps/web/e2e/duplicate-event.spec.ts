import { expect, test, type Page } from "@playwright/test";
import { openBuilder } from "#e2e/builder.ts";

/**
 * Duplicating an event (T-601, FR-1016), from the events list: the dialog starts with the event's name marked as a copy
 * and its times, the copy is a new Draft with the new times, and the original is unchanged. Arabic (right to left) and
 * English, without a sideways scroll.
 */

async function expectNoSidewaysScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

test("the owner duplicates an event into a new draft with new times, in Arabic and English", async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  await openBuilder(page, info.project.name);
  const listUrl = page.url().replace(/\/[0-9a-f-]{36}\/quests$/, "");

  await page.goto(listUrl);
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expectNoSidewaysScroll(page);
  await page.getByRole("button", { name: "نسخ الفعالية: ملتقى نجد" }).click();
  const dialog = page.getByRole("dialog", { name: "نسخ الفعالية: ملتقى نجد" });
  await expect(dialog.getByLabel("الاسم بالعربية")).toHaveValue("ملتقى نجد (نسخة)");
  await expect(dialog.getByLabel("تبدأ", { exact: true })).toHaveValue("2030-11-01T09:00");
  await expectNoSidewaysScroll(page);

  await dialog.getByLabel("الاسم بالإنجليزية").fill("Najd Meetup 2");
  await dialog.getByLabel("تبدأ", { exact: true }).fill("2031-03-01T09:00");
  await dialog.getByLabel("تنتهي", { exact: true }).fill("2031-03-01T17:00");
  await dialog.getByRole("button", { name: "نسخ", exact: true }).click();

  await expect(page).toHaveURL(/\/events\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { name: "ملتقى نجد (نسخة)", level: 1 })).toBeVisible();
  await expect(page.getByLabel("تبدأ", { exact: true })).toHaveValue("2031-03-01T09:00");
  await expect(page.getByText("مسودة", { exact: true })).toBeVisible();

  await page.goto(listUrl);
  await expect(page.getByRole("link", { name: "ملتقى نجد (نسخة)" })).toBeVisible();
  await page.getByRole("link", { name: "ملتقى نجد", exact: true }).click();
  await expect(page.getByLabel("تبدأ", { exact: true })).toHaveValue("2030-11-01T09:00");

  await page.goto(listUrl.replace("/ar/", "/en/"));
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  await expect(page.getByRole("button", { name: "Duplicate event: Najd Meetup 2" })).toBeVisible();
  await expectNoSidewaysScroll(page);
});

test("a refused body names the field and the corrected one makes the copy", async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  await openBuilder(page, info.project.name);
  const listUrl = page.url().replace(/\/[0-9a-f-]{36}\/quests$/, "");
  await page.goto(listUrl.replace("/ar/", "/en/"));

  await page.getByRole("button", { name: /^Duplicate event/ }).click();
  const dialog = page.getByRole("dialog", { name: /^Duplicate event/ });
  await dialog.getByLabel("Ends", { exact: true }).fill("2030-11-01T08:00");
  await dialog.getByRole("button", { name: "Duplicate", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("Make the end later than the start.");

  await dialog.getByLabel("Ends", { exact: true }).fill("2030-11-01T18:00");
  await dialog.getByRole("button", { name: "Duplicate", exact: true }).click();
  await expect(page).toHaveURL(/\/events\/[0-9a-f-]{36}$/);

  await page.goto(listUrl.replace("/ar/", "/en/"));
  await expect(page.getByRole("button", { name: /^Duplicate event/ })).toHaveCount(2);
});
