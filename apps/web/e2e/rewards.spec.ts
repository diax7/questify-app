import { expect, test } from "@playwright/test";
import { openBuilder } from "#e2e/builder.ts";

/** The rewards shop (T-201): add a reward, raise its stock, set the shop's pickup time, then remove the reward. */
test("the organizer builds the rewards shop", async ({ page }, info) => {
  test.setTimeout(90_000);
  await openBuilder(page, info.project.name);
  const eventPage = page.url().replace(/\/quests$/, "");
  await page.goto(eventPage);
  await page.getByRole("link", { name: "الجوائز" }).click();

  const panel = page.getByRole("region", { name: "الجوائز" });
  await expect(panel.getByText("لا جوائز بعد.")).toBeVisible();
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

  await panel.getByRole("button", { name: "إزالة" }).click();
  await panel.getByRole("button", { name: "إزالة" }).click();
  await expect(panel.getByRole("status")).toHaveText("أُزيلت الجائزة من المتجر.");
  await expect(panel.getByText("لا جوائز بعد.")).toBeVisible();
});
