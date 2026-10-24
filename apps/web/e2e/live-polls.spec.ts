import { expect, test } from "@playwright/test";
import { openBuilder } from "#e2e/builder.ts";

/**
 * A live poll in the builder (T-306), in Arabic: Live poll ticked hides the window fields, the poll is saved as a
 * draft, sent during the rehearsal after a confirmation, shown open with its counts, then closed after another.
 */
test("builds a live poll, sends it during the rehearsal, and closes it", async ({ page }, info) => {
  test.setTimeout(90_000);
  await openBuilder(page, info.project.name);
  const builder = page.url();
  // Opening the event's page starts its rehearsal (its code), so a poll can be sent before go-live.
  await page.goto(builder.replace(/\/quests$/, ""));
  await expect(page.getByRole("region", { name: "التجربة" })).toBeVisible();
  await page.goto(builder);

  await page.getByRole("button", { name: "إضافة مهمة" }).click();
  await page.getByRole("combobox", { name: /^نوع مهمة/ }).selectOption("vote");
  await page.getByLabel("العنوان بالعربية", { exact: true }).fill("المحاضرة التالية");
  await page.getByLabel("الخيار 1 بالعربية").fill("الذكاء الاصطناعي");
  await page.getByLabel("الخيار 2 بالعربية").fill("الفضاء");
  await expect(page.getByLabel("ظاهرة في التطبيق")).toBeVisible();
  await page.getByLabel("تصويت مباشر: ترسله من قائمة مهام").check();
  await expect(page.getByLabel("ظاهرة في التطبيق")).toHaveCount(0);
  await expect(page.getByText("صوّتوا على الأفكار، لا على مظهر أحد.")).toBeVisible();
  await page.getByLabel("عدة اختيارات").check();
  await page.getByLabel("عند إغلاق التصويت").check();
  await page.getByLabel(/^مدة التصويت بالدقائق/).fill("10");
  await page.getByRole("button", { name: "إنشاء مهمة" }).click();

  const poll = page.getByRole("listitem").filter({ hasText: "المحاضرة التالية" });
  await expect(poll.getByText("مسودة", { exact: true })).toBeVisible();
  await expect(poll.getByRole("button", { name: "إظهار" })).toHaveCount(0);
  await poll.getByRole("button", { name: "أرسل الآن" }).click();
  const send = page.getByRole("alertdialog");
  await expect(send).toContainText("المدة بالدقائق: 10");
  await send.getByRole("button", { name: "أرسل الآن" }).click();
  await expect(poll.getByText(/^مفتوح، يُغلق /)).toBeVisible();
  await expect(poll.getByText("عدد المصوّتين: 0")).toBeVisible();

  await poll.getByRole("button", { name: "أغلق الآن" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "أغلق الآن" }).click();
  await expect(poll.getByText("مغلق", { exact: true })).toBeVisible();
  await expect(poll.getByRole("button", { name: "أغلق الآن" })).toHaveCount(0);

  await poll.getByRole("button", { name: "تعديل" }).click();
  await expect(page.getByText("أُرسل التصويت، فلا يتغيّر عدد الاختيارات ولا المدة.")).toBeVisible();
  await expect(page.getByLabel(/^مدة التصويت بالدقائق/)).toBeDisabled();
});
