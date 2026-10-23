import { expect, test, type Page } from "@playwright/test";
import { openBuilder } from "#e2e/builder.ts";

/**
 * Meet-someone in the dashboard (T-303c), in Arabic, right to left, on the desktop and the phone screen: a meet quest
 * with its daily cap (refused above the repeat cap, before anything is sent), and the event's meet-someone switch.
 */

async function expectNoSidewaysScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

test("builds a meet quest with its daily cap, refusing a cap above the repeat cap", async ({
  page,
}, info) => {
  test.setTimeout(90_000);
  await openBuilder(page, info.project.name);
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");

  await page.getByRole("button", { name: "إضافة مهمة" }).click();
  await page.getByRole("combobox", { name: /^نوع المهمة/ }).selectOption("meet");
  await page.getByLabel("العنوان بالعربية", { exact: true }).fill("تعرّف على لاعب");
  await expect(page.getByText(/يتجدد كل دقيقة، فلا تنفع لقطات الشاشة/)).toBeVisible();
  await expect(page.getByRole("group", { name: "طريقة التحقق" })).toHaveCount(0);
  const dailyCap = page.getByLabel("الحد اليومي لكل لاعب (1 إلى 50)");
  await expect(dailyCap).toHaveValue("5");
  await expect(page.getByLabel("أقصى عدد مرات لكل لاعب")).toHaveValue("10");

  await dailyCap.fill("12");
  await page.getByRole("button", { name: "إضافة المهمة" }).click();
  await expect(page.locator("p[role=alert]")).toContainText("ولا يزيد على حد التكرار");

  await dailyCap.fill("3");
  await page.getByRole("button", { name: "إضافة المهمة" }).click();
  const quest = page.getByRole("listitem").filter({ hasText: "تعرّف على لاعب" });
  await expect(quest).toBeVisible();
  await quest.getByRole("button", { name: "تعديل" }).click();
  await expect(page.getByLabel("الحد اليومي لكل لاعب (1 إلى 50)")).toHaveValue("3");
  await expectNoSidewaysScroll(page);
});

test("the owner switches meet-someone quests off and on for the event", async ({ page }, info) => {
  test.setTimeout(90_000);
  await openBuilder(page, info.project.name);
  await page.goto(page.url().replace(/\/quests$/, ""));

  const card = page.getByRole("region", { name: "مهام التعارف" });
  const box = card.getByLabel("إظهار مهام التعارف للاعبين");
  await expect(box).toBeChecked();
  await expect(card.getByRole("status")).toContainText("مهام التعارف ظاهرة");
  await box.uncheck();
  await expect(card.getByRole("status")).toContainText("مخفية عن اللاعبين");
  await page.reload();
  await expect(
    page.getByRole("region", { name: "مهام التعارف" }).getByLabel(/مهام التعارف/),
  ).not.toBeChecked();
  await page
    .getByRole("region", { name: "مهام التعارف" })
    .getByLabel(/مهام التعارف/)
    .check();
  await expect(
    page.getByRole("region", { name: "مهام التعارف" }).getByRole("status"),
  ).toContainText("ظاهرة");
  await expectNoSidewaysScroll(page);
});
