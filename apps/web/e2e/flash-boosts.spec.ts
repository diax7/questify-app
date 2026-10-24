import { expect, test } from "@playwright/test";
import { openBuilder } from "#e2e/builder.ts";

/**
 * Flash quests and double points on the dashboard (T-307), in Arabic: a flash quest saved as a draft, launched during
 * the rehearsal after a confirmation with its minutes, shown running, then ended; the event's two switches; and a boost
 * made on the Double points page, listed as scheduled, edited and deleted after a confirmation.
 */
test("launches and ends a flash quest, and builds, edits and deletes a boost", async ({
  page,
}, info) => {
  test.setTimeout(90_000);
  await openBuilder(page, info.project.name);
  const builder = page.url();
  // Opening the event's page starts its rehearsal (its code), so a flash quest can be launched before go-live.
  const event = builder.replace(/\/quests$/, "");
  await page.goto(event);
  await expect(page.getByRole("region", { name: "التجربة" })).toBeVisible();
  await expect(page.getByLabel("تشغيل المهام الخاطفة في الفعالية")).toBeChecked();
  await expect(page.getByLabel("تشغيل النقاط المضاعفة في الفعالية")).toBeChecked();
  await page.goto(builder);

  await page.getByRole("button", { name: "إضافة مهمة" }).click();
  await page.getByLabel("العنوان بالعربية", { exact: true }).fill("الصقر الذهبي");
  await page.getByLabel("مهمة خاطفة").check();
  await expect(page.getByText(/^لا تظهر للاعبين إلا بين وقتي البدء والانتهاء/)).toBeVisible();
  await expect(page.getByLabel("ظاهرة في التطبيق")).not.toBeChecked();
  await page.getByRole("button", { name: "إضافة المهمة" }).click();

  const flash = page.getByRole("listitem").filter({ hasText: "الصقر الذهبي" });
  await expect(flash.getByText("خاطفة، لم تنطلق")).toBeVisible();
  await flash.getByRole("button", { name: "أطلق الآن" }).click();
  const launch = page.getByRole("alertdialog");
  await expect(launch).toContainText("تنطلق مرة واحدة فقط.");
  await launch.getByLabel("المدة بالدقائق (1 إلى 1440)").fill("20");
  await launch.getByRole("button", { name: "أطلق الآن" }).click();
  await expect(flash.getByText(/^خاطفة، تنتهي /)).toBeVisible();

  await flash.getByRole("button", { name: "أنهِ الآن" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "أنهِ الآن" }).click();
  await expect(flash.getByText("خاطفة، انتهت")).toBeVisible();
  await expect(flash.getByRole("button", { name: "أطلق الآن" })).toHaveCount(0);

  await page.goto(event);
  await page.getByRole("link", { name: "النقاط المضاعفة" }).click();
  await expect(page.getByRole("heading", { name: "النقاط المضاعفة" })).toBeVisible();
  await expect(page.getByText("لا توجد مضاعفات بعد.")).toBeVisible();
  await page.getByRole("button", { name: "مضاعفة جديدة" }).click();
  await page.getByLabel("ابدأ الآن").uncheck();
  await page.getByLabel("تبدأ", { exact: true }).fill("2030-11-01T10:00");
  await page.getByLabel("المدة بالدقائق (1 إلى 1440)").fill("30");
  await page.getByRole("button", { name: "حفظ" }).click();
  await expect(page.getByText("حُفظت المضاعفة.")).toBeVisible();

  const boost = page.getByRole("listitem").filter({ hasText: "مجدولة" });
  await expect(boost.getByText(/10:00/)).toBeVisible();
  await boost.getByRole("button", { name: "تعديل" }).click();
  await page.getByLabel("المدة بالدقائق (1 إلى 1440)").fill("45");
  await page.getByRole("button", { name: "حفظ" }).click();
  await expect(boost.getByText(/10:45/)).toBeVisible();

  await boost.getByRole("button", { name: "حذف" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "حذف" }).click();
  await expect(page.getByText("حُذفت المضاعفة.")).toBeVisible();
  await expect(page.getByText("لا توجد مضاعفات بعد.")).toBeVisible();
});
