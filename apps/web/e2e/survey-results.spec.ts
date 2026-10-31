import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { openBuilder } from "#e2e/builder.ts";

/**
 * A survey's results for the team and its speaker (T-508): the spreadsheet export, the speaker's link opened with no
 * account and stopped, the owner's quest ratings switch, and the results on the agenda row of a session that links the
 * survey.
 */
test("exports a survey's results, shares them with a speaker and stops sharing", async ({
  page,
  browser,
}, info) => {
  test.setTimeout(150_000);
  await openBuilder(page, info.project.name);
  const base = page.url().replace("/quests", "");

  await page.getByRole("button", { name: "إضافة مهمة" }).click();
  await page.getByRole("combobox", { name: /^نوع مهمة/ }).selectOption("survey");
  await page.getByLabel("العنوان بالعربية", { exact: true }).fill("رأيك في الفعالية");
  await page.getByLabel("نص السؤال بالعربية").fill("أي جلسة أعجبتك؟");
  await page.getByLabel("الخيار 1 بالعربية").fill("الذكاء الاصطناعي");
  await page.getByLabel("الخيار 2 بالعربية").fill("الويب");
  await page.getByRole("button", { name: "إنشاء مهمة" }).click();
  const survey = page.getByRole("listitem").filter({ hasText: "رأيك في الفعالية" });
  await expect(survey).toBeVisible();
  await expect(survey).not.toContainText("أعجب");

  await survey.getByRole("button", { name: "تعديل" }).click();
  await expect(page.getByRole("heading", { name: "نتائج الاستبيان" })).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "تصدير الجدول" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe("survey-results.csv");
  const csv = readFileSync(await file.path(), "utf8");
  expect(csv.startsWith("\uFEFF")).toBe(true);
  expect(csv).toContain("لم تصل أي إجابات.");

  await expect(page.getByText("لا رابط مشترك.")).toBeVisible();
  await page.getByRole("button", { name: "إنشاء رابط" }).click();
  const making = page.getByRole("alertdialog");
  await expect(making).toContainText("يستطيع أي شخص لديه الرابط رؤية النتائج دون تسجيل الدخول.");
  await making.getByRole("button", { name: "إلغاء" }).click();
  await expect(page.getByText("لا رابط مشترك.")).toBeVisible();
  await page.getByRole("button", { name: "إنشاء رابط" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "إنشاء رابط" }).click();
  const field = page.getByRole("textbox", { name: "رابط النتائج" });
  const link = await field.inputValue();
  expect(link).toMatch(/\/ar\/r#[A-Za-z0-9_-]{43}$/);
  await expect(page.getByText("الرابط فعّال.")).toBeVisible();

  const speaker = await (await browser.newContext()).newPage();
  await speaker.goto(link);
  await expect(speaker.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(speaker.getByRole("heading", { level: 1 })).toContainText("رأيك في الفعالية");
  await expect(speaker.getByText(/عدد الإجابات: 0\./)).toBeVisible();
  await expect(speaker.getByText(/لا تظهر أسماء اللاعبين/)).toBeVisible();

  await page.getByRole("button", { name: "إيقاف المشاركة" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "إيقاف المشاركة" }).click();
  await expect(page.getByText(/تم إيقاف المشاركة/)).toBeVisible();
  await speaker.reload();
  await expect(speaker.getByText("لم يعد هذا الرابط فعّالًا.")).toBeVisible();
  await speaker.goto(link.replace(/#.*$/, ""));
  await expect(speaker.getByText("الرابط غير مكتمل.")).toBeVisible();
  await speaker.context().close();

  await page.goto(base);
  const ratings = page.getByLabel(/السماح للاعبين بتقييم/);
  await expect(ratings).not.toBeChecked();
  await ratings.check();
  await expect(ratings).toBeChecked();
  await page.reload();
  await expect(page.getByLabel(/السماح للاعبين بتقييم/)).toBeChecked();
});

test("opens a session's survey results from its row on the agenda", async ({ page }, info) => {
  test.setTimeout(150_000);
  await openBuilder(page, info.project.name);
  const base = page.url().replace("/quests", "").replace("/ar/", "/en/");
  await page.getByRole("button", { name: "إضافة مهمة" }).click();
  await page.getByRole("combobox", { name: /^نوع مهمة/ }).selectOption("survey");
  await page.getByLabel("العنوان بالعربية", { exact: true }).fill("رأيك في الجلسة");
  await page.getByLabel("نص السؤال بالعربية").fill("هل أفادتك الجلسة؟");
  await page.getByLabel("الخيار 1 بالعربية").fill("نعم");
  await page.getByLabel("الخيار 2 بالعربية").fill("لا");
  await page.getByRole("button", { name: "إنشاء مهمة" }).click();
  await expect(page.getByRole("listitem").filter({ hasText: "رأيك في الجلسة" })).toBeVisible();

  await page.goto(base + "/sessions");
  await page.getByRole("button", { name: "Add a session" }).click();
  await page.getByLabel("Title in English").fill("Closing talk");
  await page.getByLabel(/^Starts/).fill("2030-11-01T10:00");
  await page.getByLabel(/^Ends/).fill("2030-11-01T11:00");
  await page.getByLabel(/^Linked/).selectOption({ label: "رأيك في الجلسة" });
  await page.getByRole("button", { name: "Save" }).click();
  const row = page.getByRole("listitem").filter({ hasText: "Closing talk" });
  await expect(row).toBeVisible();

  await row.getByRole("button", { name: "Survey results" }).click();
  await expect(row.getByRole("heading", { name: "Survey results" })).toBeVisible();
  await expect(row.getByText("0 responses.")).toBeVisible();
  await expect(row.getByRole("heading", { name: "Share with the speaker" })).toBeVisible();
  await row.getByRole("button", { name: "Survey results" }).click();
  await expect(row.getByRole("heading", { name: "Survey results" })).toHaveCount(0);
});
