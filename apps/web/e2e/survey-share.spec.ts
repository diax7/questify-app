import { expect, test } from "@playwright/test";
import { openBuilder } from "#e2e/builder.ts";

/**
 * Challenge, survey and share quests in the builder (T-303), in Arabic: a challenge with no method to choose, a survey
 * with a choice and a rating question, a share with its message and link, and the survey's results (names not shown)
 * when it is opened again.
 */
test("builds a challenge, a survey and a share quest", async ({ page }, info) => {
  test.setTimeout(90_000);
  await openBuilder(page, info.project.name);

  await page.getByRole("button", { name: "إضافة مهمة" }).click();
  await page.getByRole("combobox", { name: /^نوع مهمة/ }).selectOption("challenge");
  await page.getByLabel("العنوان بالعربية", { exact: true }).fill("تحدي الرماية");
  await expect(page.getByText(/يؤكد المشغّل هذا التحدي/)).toBeVisible();
  await expect(page.getByRole("group", { name: "طريقة التحقق" })).toHaveCount(0);
  await page.getByRole("button", { name: "إنشاء مهمة" }).click();
  await expect(page.getByText("تحدي الرماية", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "إضافة مهمة" }).click();
  await page.getByRole("combobox", { name: /^نوع مهمة/ }).selectOption("survey");
  await page.getByLabel("العنوان بالعربية", { exact: true }).fill("رأيك في الفعالية");
  await expect(page.getByLabel("يمكن إكمالها أكثر من مرة")).toHaveCount(0);
  await page.getByLabel("نص السؤال بالعربية").fill("أي جلسة أعجبتك؟");
  await page.getByLabel("الخيار 1 بالعربية").fill("الذكاء الاصطناعي");
  await page.getByLabel("الخيار 2 بالعربية").fill("الويب");
  await page.getByRole("button", { name: "إضافة سؤال" }).click();
  await page.getByLabel("نص السؤال بالعربية").nth(1).fill("قيّم الفعالية");
  await page.getByLabel("نوع السؤال").nth(1).selectOption("rating");
  await page.getByLabel("سؤال مطلوب").nth(1).uncheck();
  await page.getByRole("button", { name: "إنشاء مهمة" }).click();
  await expect(page.getByText("رأيك في الفعالية", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "إضافة مهمة" }).click();
  await page.getByRole("combobox", { name: /^نوع مهمة/ }).selectOption("share");
  await page.getByLabel("العنوان بالعربية", { exact: true }).fill("شارك الفعالية");
  await page.getByLabel("الرسالة بالعربية").fill("أنا في الفعالية الآن!");
  await page.getByLabel(/^رابط/).fill("https://example.com/fest");
  await page.getByRole("button", { name: "إنشاء مهمة" }).click();
  await expect(page.getByText("شارك الفعالية", { exact: true })).toBeVisible();

  const survey = page.getByRole("listitem").filter({ hasText: "رأيك في الفعالية" });
  await survey.getByRole("button", { name: "تعديل" }).click();
  await expect(page.getByRole("heading", { name: "نتائج الاستبيان" })).toBeVisible();
  await expect(page.getByText(/عدد الإجابات: 0\./)).toBeVisible();
  await expect(page.getByText(/لا تظهر أسماء اللاعبين/)).toBeVisible();
  await expect(page.getByLabel("نوع السؤال").nth(1)).toHaveValue("rating");
});
