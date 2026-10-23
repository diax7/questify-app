import { expect, test } from "@playwright/test";
import { openBuilder } from "#e2e/builder.ts";

/**
 * The rewards shop (T-201, T-206): set the prize desk, add a reward, raise its stock, set the shop's pickup time, then
 * remove the reward.
 */
test("the organizer builds the rewards shop", async ({ page }, info) => {
  test.setTimeout(90_000);
  await openBuilder(page, info.project.name);
  const eventPage = page.url().replace(/\/quests$/, "");
  await page.goto(eventPage);
  await page.getByRole("link", { name: "الجوائز", exact: true }).click();

  const panel = page.getByRole("region", { name: "الجوائز" });
  await expect(panel.getByText("لا جوائز بعد.")).toBeVisible();

  // An item reward needs the prize desk's place first (FR-1716).
  await panel.getByRole("button", { name: "إضافة جائزة" }).click();
  await expect(panel.getByRole("alert")).toHaveText(
    "حدّد مكان مكتب الجوائز قبل إضافة جوائز تُستلم منه.",
  );
  await expect(panel.getByRole("button", { name: "حفظ الجائزة" })).toBeDisabled();
  await panel.getByRole("button", { name: "إلغاء", exact: true }).click();

  // The desk: its place, optional hours as windows, and how players confirm (ADR-150).
  await panel.getByLabel("مكان المكتب بالعربية").fill("القاعة ب");
  await panel.getByRole("checkbox", { name: "تحديد ساعات عمل للمكتب" }).check();
  await panel.getByLabel("يفتح").fill("2030-01-01T22:00");
  await panel.getByLabel("يغلق").fill("2030-01-01T18:00");
  await panel.getByRole("button", { name: "حفظ المكتب" }).click();
  await expect(panel.getByRole("alert")).toHaveText(
    "أضف من فترة إلى 14 فترة بالترتيب، تُغلق كل منها بعد أن تفتح ولا تتداخل مع التالية.",
  );
  await panel.getByLabel("يفتح").fill("2030-01-01T16:00");
  await panel.getByLabel("يغلق").fill("2030-01-01T22:00");
  await panel.getByRole("radio", { name: "يعرض المكتب التسليم، ويقبله اللاعب في تطبيقه." }).check();
  await panel.getByRole("button", { name: "حفظ المكتب" }).click();
  await expect(panel.getByRole("status")).toHaveText("حُفظ مكتب الجوائز.");
  await page.reload();
  await expect(panel.getByLabel("مكان المكتب بالعربية")).toHaveValue("القاعة ب");
  await expect(panel.getByLabel("يفتح")).toHaveValue("2030-01-01T16:00");
  await expect(
    panel.getByRole("radio", { name: "يعرض المكتب التسليم، ويقبله اللاعب في تطبيقه." }),
  ).toBeChecked();

  await panel.getByRole("button", { name: "إضافة جائزة" }).click();

  // A missing name is named before anything is sent.
  await panel.getByRole("button", { name: "حفظ الجائزة" }).click();
  await expect(panel.getByRole("alert")).toHaveText("اكتب الاسم بلغة واحدة على الأقل.");

  await panel.getByLabel("الاسم بالعربية").fill("هودي الفعالية");
  await panel.getByLabel("الاسم بالإنجليزية").fill("Event hoodie");
  await panel.getByLabel("السعر (نقاط)").fill("250");
  await panel.getByLabel("الكمية").fill("3");
  await panel.getByRole("checkbox", { name: "جديدة" }).check();
  await panel.getByRole("button", { name: "حفظ الجائزة" }).click();
  await expect(panel.getByRole("status")).toHaveText("حُفظت الجائزة.");
  await expect(panel.getByText("متبقٍّ 3 من 3")).toBeVisible();

  await panel.getByRole("button", { name: "تعديل" }).click();
  await panel.getByLabel("الكمية").fill("8");
  await panel.getByRole("button", { name: "حفظ الجائزة" }).click();
  await expect(panel.getByText("متبقٍّ 8 من 8")).toBeVisible();

  await panel.getByLabel("مهلة الاستلام بالدقائق").fill("5");
  await panel.getByRole("button", { name: "حفظ الإعدادات" }).click();
  await expect(panel.getByRole("alert")).toHaveText(
    "مهلة الاستلام من 15 دقيقة إلى 10080 دقيقة (7 أيام).",
  );
  await panel.getByLabel("مهلة الاستلام بالدقائق").fill("90");
  await panel.getByRole("button", { name: "حفظ الإعدادات" }).click();
  await expect(panel.getByRole("status")).toHaveText("حُفظت إعدادات المتجر.");
  await page.reload();
  await expect(panel.getByLabel("مهلة الاستلام بالدقائق")).toHaveValue("90");

  // The owner chooses, before the event starts, whether spending lowers the ranking (T-219).
  const spendRank = panel.getByRole("checkbox", { name: "الشراء من المتجر يخفض نقاط الترتيب" });
  await expect(spendRank).not.toBeChecked();
  await spendRank.check();
  await panel.getByRole("button", { name: "حفظ الإعدادات" }).click();
  await expect(panel.getByRole("status")).toHaveText("حُفظت إعدادات المتجر.");
  await page.reload();
  await expect(spendRank).toBeChecked();

  await panel.getByRole("button", { name: "إزالة" }).click();
  await panel.getByRole("button", { name: "إزالة" }).click();
  await expect(panel.getByRole("status")).toHaveText("أُزيلت الجائزة من المتجر.");
  await expect(panel.getByText("لا جوائز بعد.")).toBeVisible();

  // A digital reward has no stock field; it warns until its codes are uploaded (T-203).
  await panel.getByRole("button", { name: "إضافة جائزة" }).click();
  await panel.getByRole("radio", { name: "رمز رقمي يظهر فور الاستبدال" }).check();
  await expect(panel.getByLabel("الكمية")).toHaveCount(0);
  await panel.getByLabel("الاسم بالعربية").fill("بطاقة إهداء");
  await panel.getByLabel("السعر (نقاط)").fill("100");
  await panel.getByRole("button", { name: "حفظ الجائزة" }).click();
  await expect(panel.getByRole("status")).toHaveText("حُفظت الجائزة.");
  const lowCodes = panel.getByRole("note");
  await expect(lowCodes).toContainText("رموز توشك على النفاد");
  await expect(lowCodes).toContainText("بطاقة إهداء: متبقٍّ 0");

  await panel.getByRole("button", { name: "إضافة رموز" }).click();
  await panel.getByRole("button", { name: "رفع الرموز" }).click();
  await expect(panel.getByRole("alert")).toHaveText("أضف رمزًا واحدًا على الأقل.");
  const codes = Array.from({ length: 30 }, (_, i) => `GIFT-${i}`);
  await panel.getByLabel("الرموز، رمز في كل سطر").fill([...codes, "GIFT-0"].join("\n"));
  await panel.getByRole("button", { name: "رفع الرموز" }).click();
  await expect(panel.getByRole("status")).toHaveText("الرموز المضافة: 30. المكررة ولم تُضف: 1.");
  await expect(panel.getByText("متبقٍّ 30 من 30")).toBeVisible();
  await expect(lowCodes).toHaveCount(0);
});
