import { expect, test } from "@playwright/test";
import { openBuilder } from "#e2e/builder.ts";

/**
 * Quest items (T-304d), in Arabic: an item needs the prize desk; the organizer adds one on the Prizes page, picks it on
 * a quest and on a category, sees what gives it, and cannot remove it while linked.
 */
test("the organizer adds a quest item and gives it with a quest and a category", async ({
  page,
}, info) => {
  test.setTimeout(90_000);
  await openBuilder(page, info.project.name);
  const builderPage = page.url();
  const prizesPage = builderPage.replace(/\/quests$/, "/prizes");

  await page.goto(prizesPage);
  const items = page.getByRole("region", { name: "هدايا مهام" });
  await expect(items.getByText("لا توجد هدايا بعد.")).toBeVisible();
  await items.getByRole("button", { name: "إضافة هدية" }).click();
  await items.getByLabel("الاسم بالعربية", { exact: true }).fill("قميص الفعالية");
  await items.getByRole("button", { name: "حفظ الهدية" }).click();
  await expect(items.getByRole("alert")).toHaveText(
    "حدّد مكان مكتب الجوائز قبل إضافة جوائز تُستلم منه.",
  );

  await page.goto(builderPage.replace(/\/quests$/, "/rewards"));
  const rewards = page.getByRole("region", { name: "الجوائز" });
  await rewards.getByLabel("مكان المكتب بالعربية").fill("القاعة ب");
  await rewards.getByRole("button", { name: "حفظ المكتب" }).click();
  await expect(rewards.getByRole("status")).toHaveText("حُفظ مكتب الجوائز.");

  await page.goto(prizesPage);
  await items.getByRole("button", { name: "إضافة هدية" }).click();
  await items.getByLabel("الاسم بالعربية", { exact: true }).fill("قميص الفعالية");
  await items.getByLabel("الكمية").fill("5");
  await items.getByRole("button", { name: "حفظ الهدية" }).click();
  await expect(items.getByRole("status")).toHaveText("حُفظت الهدية.");
  const card = items.getByRole("listitem").filter({ hasText: "قميص الفعالية" });
  await expect(card).toContainText("المتبقي: 5 من 5");
  await expect(card).toContainText("لم تُربط بأي مهمة أو فئة بعد.");

  await page.goto(builderPage);
  await page.getByRole("button", { name: "إضافة مهمة" }).click();
  await page.getByLabel("العنوان بالعربية", { exact: true }).fill("ابحث عن الصقر");
  await page
    .getByRole("combobox", { name: /^هدية/ })
    .selectOption({ label: "قميص الفعالية (المتبقي: 5 من 5)" });
  await page.getByRole("button", { name: "إنشاء مهمة" }).click();
  await expect(page.getByText("ابحث عن الصقر", { exact: true })).toBeVisible();
  const general = page.getByRole("region", { name: "عام" });
  await general.getByRole("button", { name: "تعديل فئة" }).click();
  await general
    .getByRole("combobox", { name: /^هدية/ })
    .selectOption({ label: "قميص الفعالية (المتبقي: 5 من 5)" });
  await general.getByRole("button", { name: "حفظ فئة" }).click();
  await expect(general.getByRole("button", { name: "تعديل فئة" })).toBeVisible();

  await page.goto(prizesPage);
  await expect(card).toContainText("تُمنح عند: ابحث عن الصقر، عام");
  await card.getByRole("button", { name: "حذف" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "حذف" }).click();
  await expect(items.getByRole("alert")).toHaveText(
    "هذه الهدية مرتبطة بمهام أو فئات. ألغِ ربطها أولًا.",
  );
});
