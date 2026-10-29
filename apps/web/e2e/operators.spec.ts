import { expect, test } from "@playwright/test";
import { openBuilder } from "#e2e/builder.ts";
import { openMenu } from "#e2e/nav.ts";

/**
 * Operators (T-204): the owner makes a personal operator code and a batch, sees them ready to print, cancels one, and
 * a scan quest offers both ways to verify it (T-205).
 */
test("the owner invites operators and prints their codes", async ({ page }, info) => {
  test.setTimeout(90_000);
  await openBuilder(page, info.project.name);

  // FR-301: a scan quest is verified by its printed QR, by staff scanning My QR, or both; never neither.
  await page.getByRole("button", { name: "إضافة مهمة" }).first().click();
  const myQr = page.getByRole("checkbox", { name: "يمسح المشغّل رمز اللاعب" });
  await expect(page.getByRole("checkbox", { name: "يمسح اللاعب رمز مهمة" })).toBeChecked();
  await expect(myQr).not.toBeChecked();
  await page.getByRole("checkbox", { name: "يمسح اللاعب رمز مهمة" }).uncheck();
  await page.getByLabel("العنوان بالعربية").fill("بوابة الدخول");
  await page.getByRole("button", { name: "إنشاء مهمة" }).click();
  await expect(page.getByText("اختر طريقة واحدة على الأقل.")).toBeVisible();
  await myQr.check();
  await page.getByRole("button", { name: "إنشاء مهمة" }).click();
  await expect(page.getByText("بوابة الدخول")).toBeVisible();

  const eventPage = page.url().replace(/\/quests$/, "");
  await page.goto(eventPage);
  await openMenu(page);
  await page.getByRole("link", { name: "المشغّلون" }).click();
  const panel = page.getByRole("region", { name: "المشغّلون" });
  await expect(panel.getByText("لا مشغّلين بعد.")).toBeVisible();

  await panel.getByLabel("الاسم").fill("نورة");
  await panel.getByLabel("الصلاحيات").selectOption({ label: "المسح فقط" });
  await panel.getByRole("button", { name: "إنشاء" }).click();
  await expect(panel.getByText("لم تُستخدم")).toHaveCount(1);
  await expect(panel.getByRole("img", { name: "رمز مشغّل لـ نورة" })).toBeVisible();

  await panel.getByLabel("الطريقة").selectOption({ label: "مجموعة رموز" });
  await panel.getByLabel("الاسم").fill("فريق البوابة");
  await panel.getByLabel("العدد").fill("3");
  await panel.getByRole("button", { name: "إنشاء" }).click();
  await expect(panel.getByText("لم تُستخدم")).toHaveCount(4);
  await expect(panel.getByRole("img", { name: /رمز مشغّل لـ فريق البوابة/ })).toHaveCount(3);
  await expect(panel.getByRole("button", { name: "طباعة الرموز" })).toBeVisible();

  await panel.getByRole("button", { name: "إلغاء الرمز" }).first().click();
  await expect(panel.getByText("أُلغيت")).toHaveCount(1);
  await expect(panel.getByRole("img", { name: /رمز مشغّل لـ/ })).toHaveCount(3);
});
