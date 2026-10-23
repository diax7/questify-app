import { expect, test } from "@playwright/test";
import { openBuilder } from "#e2e/builder.ts";

/**
 * The rehearsal card (T-211) on a new draft's page: the code the team joins with, Change code and Erase rehearsal,
 * each confirmed, in Arabic; the card's heading in English.
 */
test("the owner reads the rehearsal code, changes it and erases the rehearsal", async ({
  page,
}, info) => {
  test.setTimeout(90_000);
  await openBuilder(page, info.project.name);
  await page.goto(page.url().replace(/\/quests$/, ""));
  const card = page.getByRole("region", { name: "التجربة" });
  await expect(card).toBeVisible();
  const line = card.getByText(/^رمز التجربة: /);
  await expect(line).toHaveText(/^رمز التجربة: [A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  const first = await line.textContent();
  await expect(card.getByText("حسابات التجربة: 0 من 25")).toBeVisible();

  await card.getByRole("button", { name: "غيّر الرمز" }).click();
  const rotate = card.getByRole("alertdialog");
  await expect(rotate).toContainText("سيتوقف الرمز القديم فورًا.");
  await rotate.getByRole("button", { name: "غيّر الرمز" }).click();
  await expect(line).not.toHaveText(first ?? "");

  await card.getByRole("button", { name: "امسح التجربة" }).click();
  await card.getByRole("alertdialog").getByRole("button", { name: "امسح التجربة" }).click();
  await expect(card.getByRole("status")).toHaveText("مُسحت بيانات التجربة: 0 حساب، و0 مسح، و0 حجز.");

  await page.goto(page.url().replace("/ar/", "/en/"));
  await expect(page.getByRole("heading", { name: "Rehearsal", level: 2 })).toBeVisible();
});
