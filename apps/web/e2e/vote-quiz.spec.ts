import { expect, test } from "@playwright/test";
import { openBuilder } from "#e2e/builder.ts";

/**
 * Vote and quiz quests in the builder (T-302), in Arabic: a vote's own options, a quiz with a timer and its right
 * answer, neither offering "more than once", and the vote's counts when it is opened again.
 */
test("builds a vote and a quiz, each played once", async ({ page }, info) => {
  test.setTimeout(90_000);
  await openBuilder(page, info.project.name);

  await page.getByRole("button", { name: "إضافة مهمة" }).click();
  await page.getByRole("combobox", { name: /^نوع المهمة/ }).selectOption("vote");
  await page.getByLabel("العنوان بالعربية", { exact: true }).fill("أفضل جناح");
  await expect(page.getByLabel("يمكن إكمالها أكثر من مرة")).toHaveCount(0);
  await page.getByLabel("الخيار 1 بالعربية").fill("الروبوتات");
  await page.getByLabel("الخيار 2 بالعربية").fill("الفضاء");
  await page.getByRole("button", { name: "إضافة خيار" }).click();
  await page.getByLabel("الخيار 3 بالعربية").fill("المحيطات");
  await page.getByRole("button", { name: "حذف الخيار 3" }).click();
  await page.getByRole("button", { name: "إضافة المهمة" }).click();
  await expect(page.getByText("أفضل جناح", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "إضافة مهمة" }).click();
  await page.getByRole("combobox", { name: /^نوع المهمة/ }).selectOption("quiz");
  await page.getByLabel("العنوان بالعربية", { exact: true }).fill("اختبار التاريخ");
  await page.getByLabel(/^الوقت لكل سؤال بالثواني/).fill("30");
  await page.getByLabel("نص السؤال بالعربية").fill("متى تأسست الدرعية؟");
  await page.getByLabel("الخيار 1 بالعربية").fill("1727");
  await page.getByLabel("الخيار 2 بالعربية").fill("1902");
  await page.getByLabel("الإجابة الصحيحة").selectOption({ label: "الخيار 1" });
  await page.getByRole("button", { name: "إضافة المهمة" }).click();
  await expect(page.getByText("اختبار التاريخ", { exact: true })).toBeVisible();

  const vote = page.getByRole("listitem").filter({ hasText: "أفضل جناح" });
  await vote.getByRole("button", { name: "تعديل" }).click();
  await expect(page.getByRole("heading", { name: "الأصوات" })).toBeVisible();
  await expect(page.getByText("مجموع الأصوات: 0")).toBeVisible();
  await expect(page.getByLabel("الخيار 2 بالعربية")).toHaveValue("الفضاء");
});
