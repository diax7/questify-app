import { expect, test } from "@playwright/test";
import { openBuilder } from "#e2e/builder.ts";

/**
 * Community quests on the dashboard (T-306b, T-306c), in Arabic: the event's switch and its warning, then a goal whose
 * milestone unlocks a category, made on the Community page with its bar preview, listed as scheduled with what it
 * unlocks, edited, and deleted after a confirmation.
 */
test("switches community quests, builds a goal with an unlock milestone, edits and deletes it", async ({
  page,
}, info) => {
  test.setTimeout(90_000);
  await openBuilder(page, info.project.name);
  const event = page.url().replace(/\/quests$/, "");
  await page.goto(event);
  const toggle = page.getByLabel("تشغيل المهام الجماعية في الفعالية");
  await expect(toggle).toBeChecked();
  await expect(page.getByText("تعمل المهام الجماعية في وقتها ويظهر شريطها للاعبين.")).toBeVisible();
  await expect(
    page.getByText("إيقافها يُنهي الهدف الجاري، ويبقى ما كان سيفتحه مقفلًا."),
  ).toBeVisible();

  await page.getByRole("link", { name: "المهام الجماعية" }).click();
  await expect(page.getByRole("heading", { name: "المهام الجماعية" })).toBeVisible();
  await expect(page.getByText("لا توجد مهام جماعية بعد.")).toBeVisible();
  await page.getByRole("button", { name: "مهمة جماعية جديدة" }).click();
  await page.getByLabel("العنوان بالعربية").fill("أضيئوا البرج");
  await page.getByLabel("الهدف", { exact: true }).fill("1000");
  await page.getByLabel("يبدأ", { exact: true }).fill("2030-11-01T10:00");
  await page.getByLabel("ينتهي", { exact: true }).fill("2030-11-01T11:00");
  await page.getByLabel("النقاط (1 إلى 100000)").fill("20");
  await page.getByRole("button", { name: "إضافة محطة" }).click();
  await page.getByLabel("عند", { exact: true }).fill("250");
  await page.getByLabel("مكافأة بلوغ الهدف").nth(1).selectOption({ label: "فتح عنصر" });
  await page.getByLabel("ما الذي يُفتح").selectOption({ label: "فئة" });
  await page.getByLabel("فئة", { exact: true }).selectOption({ index: 1 });
  await expect(page.getByText(/^يبقى مقفلًا للاعبين من لحظة الحفظ/)).toBeVisible();
  await expect(page.getByText("يرى كل اللاعبين عنوان الهدف، فلا تذكر فيه فئة مخفية.")).toBeVisible();
  await expect(page.getByText(/^🔒 يفتح /)).toBeVisible();
  await expect(page.getByText("هكذا يظهر الشريط للاعبين في البداية وعند أول محطة.")).toBeVisible();
  await page.getByRole("button", { name: "حفظ" }).click();
  await expect(page.getByText("حُفظت المهمة الجماعية.")).toBeVisible();

  const goal = page.getByRole("listitem").filter({ hasText: "أضيئوا البرج" });
  await expect(goal.getByText("مجدولة", { exact: true })).toBeVisible();
  await expect(goal.getByRole("progressbar", { name: "تقدّم المهمة الجماعية" })).toBeVisible();
  await expect(goal.getByText(/^0 من 1.?000$/)).toBeVisible();
  await expect(goal.getByText(/^يفتح: /)).toBeVisible();

  await goal.getByRole("button", { name: "تعديل" }).click();
  await page.getByLabel("الهدف", { exact: true }).fill("2000");
  await page.getByRole("button", { name: "حفظ" }).click();
  await expect(goal.getByText(/^0 من 2.?000$/)).toBeVisible();

  await goal.getByRole("button", { name: "حذف" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "حذف" }).click();
  await expect(page.getByText("حُذفت المهمة الجماعية.")).toBeVisible();
  await expect(page.getByText("لا توجد مهام جماعية بعد.")).toBeVisible();
});
