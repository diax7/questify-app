import { expect, test, type Page } from "@playwright/test";
import { openBuilder } from "#e2e/builder.ts";

/**
 * Mini-games in the dashboard (T-305, T-305c), in Arabic, right to left, on the desktop and the phone screen: a game
 * quest with its game (all four, the real-time pair with its note), level, attempts and the line players see, and the
 * event's mini-games switch.
 */

async function expectNoSidewaysScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

test("builds a game quest with its level, unlimited attempts and the players' line", async ({
  page,
}, info) => {
  test.setTimeout(90_000);
  await openBuilder(page, info.project.name);
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");

  await page.getByRole("button", { name: "إضافة مهمة" }).click();
  await page.getByRole("combobox", { name: /^نوع المهمة/ }).selectOption("game");
  await page.getByLabel("العنوان بالعربية", { exact: true }).fill("تحدي الذاكرة");
  await expect(page.getByRole("group", { name: "طريقة التحقق" })).toHaveCount(0);
  const game = page.getByRole("combobox", { name: "اللعبة" });
  await expect(game.locator("option")).toHaveText([
    "لعبة الذاكرة",
    "أحجية الصورة المنزلقة",
    "الالتقاط",
    "النقر السريع",
  ]);
  await page.getByRole("combobox", { name: "المستوى" }).selectOption("medium");
  await expect(
    page.getByText("يرى اللاعبون: اعثر على جميع الأزواج (8) في 20 حركة أو أقل."),
  ).toBeVisible();
  const quickNote = page.getByText(/يتطلب الالتقاط والنقر السريع سرعة في الملاحظة واللمس/);
  await expect(quickNote).toHaveCount(0);
  await game.selectOption("catch");
  await expect(page.getByText("يرى اللاعبون: التقط 30 عنصرًا على الأقل من 40.")).toBeVisible();
  await expect(quickNote).toBeVisible();
  await game.selectOption("tap_rush");
  await expect(
    page.getByText("يرى اللاعبون: اجمع 28 نقطة خلال 30 ثانية. كل نقرة خاطئة تخصم نقطة."),
  ).toBeVisible();
  await expect(page.getByLabel("عدد المحاولات (1 إلى 10)")).toHaveValue("1");
  await page.getByLabel("محاولات غير محدودة، مع انتظار بين الجولات").check();
  await page.getByLabel("الانتظار بين الجولات بالدقائق (1 إلى 1440)").fill("15");
  await game.selectOption("slide_puzzle");
  await expect(page.getByText("يرى اللاعبون: أعد ترتيب الصورة خلال 180 ثانية.")).toBeVisible();

  await page.getByRole("button", { name: "إضافة المهمة" }).click();
  const quest = page.getByRole("listitem").filter({ hasText: "تحدي الذاكرة" });
  await expect(quest).toBeVisible();
  await quest.getByRole("button", { name: "تعديل" }).click();
  await expect(page.getByRole("combobox", { name: "اللعبة" })).toHaveValue("slide_puzzle");
  await expect(page.getByLabel("الانتظار بين الجولات بالدقائق (1 إلى 1440)")).toHaveValue("15");
  await expectNoSidewaysScroll(page);
});

test("the owner switches mini-games off and on for the event", async ({ page }, info) => {
  test.setTimeout(90_000);
  await openBuilder(page, info.project.name);
  await page.goto(page.url().replace(/\/quests$/, ""));

  const card = page.getByRole("region", { name: "الألعاب المصغّرة" });
  const box = card.getByLabel("إظهار الألعاب المصغّرة للاعبين");
  await expect(box).toBeChecked();
  await expect(card.getByRole("status")).toContainText("الألعاب المصغّرة ظاهرة");
  await box.uncheck();
  await expect(card.getByRole("status")).toContainText("مخفية عن اللاعبين");
  await page.reload();
  const again = page.getByRole("region", { name: "الألعاب المصغّرة" });
  await expect(again.getByLabel("إظهار الألعاب المصغّرة للاعبين")).not.toBeChecked();
  await again.getByLabel("إظهار الألعاب المصغّرة للاعبين").check();
  await expect(again.getByRole("status")).toContainText("ظاهرة");
  await expectNoSidewaysScroll(page);
});
