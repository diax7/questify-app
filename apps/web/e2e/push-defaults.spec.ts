import { expect, test, type Page } from "@playwright/test";
import { openBuilder } from "#e2e/builder.ts";

/**
 * An event's default notification topics (T-510, FR-1836), on the Announcements page: all four start on, a switch saves
 * as it moves and is still there after a reload, in Arabic (right to left) and in English, without a sideways scroll.
 */

async function expectNoSidewaysScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

test("the owner switches a default topic off and on, in Arabic and English", async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  await openBuilder(page, info.project.name);
  const eventUrl = page.url().replace(/\/quests$/, "");

  await page.goto(`${eventUrl}/announcements`);
  const arabic = page.getByRole("region", { name: "الإشعارات الافتراضية" });
  const rank = arabic.getByLabel("الترتيب");
  await expect(arabic.getByRole("checkbox")).toHaveCount(4);
  for (const box of await arabic.getByRole("checkbox").all()) await expect(box).toBeChecked();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expectNoSidewaysScroll(page);

  await rank.uncheck();
  await expect(arabic.getByRole("alert")).toHaveCount(0);
  await page.reload();
  await expect(rank).not.toBeChecked();
  await expect(arabic.getByLabel("التذكيرات")).toBeChecked();

  await page.goto(`${eventUrl.replace("/ar/", "/en/")}/announcements`);
  const english = page.getByRole("region", { name: "Default notifications" });
  await expect(english.getByLabel("Ranking")).not.toBeChecked();
  await expect(english.getByLabel("Reminders")).toBeChecked();
  await expectNoSidewaysScroll(page);

  await english.getByLabel("Ranking").check();
  await page.reload();
  await expect(english.getByLabel("Ranking")).toBeChecked();
});
