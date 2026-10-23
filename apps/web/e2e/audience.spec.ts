import { expect, test } from "@playwright/test";
import { openBuilder } from "#e2e/builder.ts";

/**
 * Targeting (T-220): the owner adds a choice field and tagged guests on the Joining page, then keeps the General
 * category for one answer and then for one tag, in English and Arabic.
 */
test("the owner keeps a category for an answer, then for a guest tag", async ({ page }, info) => {
  test.setTimeout(90_000);
  await openBuilder(page, info.project.name);
  await page.goto(
    page
      .url()
      .replace(/\/quests$/, "/joining")
      .replace("/ar/", "/en/"),
  );

  await page.getByRole("button", { name: "Add a field" }).click();
  await page.getByRole("combobox", { name: "Field", exact: true }).selectOption("custom");
  await page.getByLabel("Label in English").fill("Section");
  await page.getByLabel("Players choose the answer from a list").check();
  await page.getByLabel("Option 1 in English").fill("Women");
  await page.getByLabel("Option 2 in English").fill("Men");
  await page.getByRole("button", { name: "Save the fields" }).click();
  await expect(page.getByRole("status").filter({ hasText: "The fields are saved." })).toBeVisible();

  await page.getByLabel("Saudi mobile numbers or emails, one per line").fill("0512345678");
  await page.getByLabel("Tag for these lines (optional)").fill("VIP");
  await expect(page.getByText("Everyone added here is invited")).toBeVisible();
  await page.getByRole("button", { name: "Add to the list" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Added: 1." })).toBeVisible();

  await page.reload();
  const panel = page.getByRole("region", { name: "Who sees what" });
  const general = panel.getByRole("listitem").filter({ hasText: "General" });
  await expect(general).toContainText("Everyone sees it");
  await general.getByRole("button", { name: "Change General" }).click();
  await general.getByLabel("By an answer at joining").check();
  await general.getByLabel("Women").check();
  await general.getByRole("button", { name: "Save" }).click();
  await expect(general).toContainText(
    "For players who answered Section: Women · 0 players match now",
  );

  await general.getByRole("button", { name: "Change General" }).click();
  await general.getByLabel("By a guest list tag").check();
  await general.getByLabel("VIP (1)").check();
  await general.getByRole("button", { name: "Save" }).click();
  await expect(general).toContainText("For guests tagged: vip");

  await page.goto(page.url().replace("/en/", "/ar/"));
  const arabic = page
    .getByRole("region", { name: "من يرى ماذا" })
    .getByRole("listitem")
    .filter({ hasText: "عام" });
  await expect(arabic).toContainText("للمدعوين بوسم: vip");
  await arabic.getByRole("button", { name: "تغيير عام" }).click();
  await arabic.getByLabel("الجميع").check();
  await arabic.getByRole("button", { name: "حفظ" }).click();
  await expect(arabic).toContainText("يراها الجميع");
});
