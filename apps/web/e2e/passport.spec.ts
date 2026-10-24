import { expect, test } from "@playwright/test";
import { openBuilder } from "#e2e/builder.ts";

/**
 * A passport quest in the builder (T-304b), in Arabic: its steps and how many are needed, a refusal for asking more
 * than there are, and one printed code per step on the codes page.
 */
test("builds a passport with its steps and prints a code for each step", async ({ page }, info) => {
  test.setTimeout(90_000);
  await openBuilder(page, info.project.name);

  await page.getByRole("button", { name: "إضافة مهمة" }).click();
  await page.getByRole("combobox", { name: /^نوع مهمة/ }).selectOption("passport");
  await page.getByLabel("العنوان بالعربية", { exact: true }).fill("جواز الأجنحة");
  await expect(page.getByLabel("يمكن إكمالها أكثر من مرة")).toHaveCount(0);
  await page.getByLabel("الخطوة 1 بالعربية").fill("جناح التقنية");
  await page.getByRole("button", { name: "إضافة خطوة" }).click();
  await page.getByLabel("الخطوة 2 بالعربية").fill("جناح الفنون");
  await page.getByLabel("الخطوات المطلوبة لإنهاء الجواز").fill("3");
  await page.getByRole("button", { name: "إنشاء مهمة" }).click();
  await expect(page.getByText(/اجعل عدد الخطوات المطلوبة بين 1 وعدد الخطوات/)).toBeVisible();
  await page.getByLabel("الخطوات المطلوبة لإنهاء الجواز").fill("2");
  await page.getByRole("button", { name: "إنشاء مهمة" }).click();
  await expect(page.getByText("جواز الأجنحة", { exact: true })).toBeVisible();

  await page.goto(page.url().replace(/\/quests$/, "/codes"));
  await expect(page.getByRole("heading", { name: "رموز QR للطباعة", level: 1 })).toBeVisible();
  await expect(
    page.getByRole("img", { name: "رمز QR، مهمة: «جواز الأجنحة - جناح التقنية»" }),
  ).toBeVisible();
  await expect(
    page.getByRole("img", { name: "رمز QR، مهمة: «جواز الأجنحة - جناح الفنون»" }),
  ).toBeVisible();
  await expect(page.getByText("الخطوة: جناح الفنون")).toBeVisible();
});
