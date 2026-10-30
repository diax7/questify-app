import { expect, test } from "@playwright/test";
import { openBuilder } from "#e2e/builder.ts";

test("adds a sponsor, tags a category to it, shows it on the builder, and deletes it, in English and in Arabic", async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  await openBuilder(page, info.project.name);
  const base = page.url().replace("/quests", "").replace("/ar/", "/en/");
  await page.goto(base + "/sponsors");
  await expect(page.getByRole("heading", { name: "Sponsors", level: 1 })).toBeVisible();
  await expect(page.getByText("No sponsors yet.")).toBeVisible();

  await page.getByRole("button", { name: "Add a sponsor" }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Write a name in at least one language." }),
  ).toBeVisible();
  await page.getByLabel("Name in English", { exact: true }).fill("Acme Dates");
  await page.getByLabel("Name in Arabic", { exact: true }).fill("تمور أكمي");
  await page.getByLabel("Tier", { exact: true }).selectOption("gold");
  await page.getByLabel("Booth", { exact: true }).fill("B14");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Sponsor saved.");
  const acme = page.getByRole("listitem").filter({ hasText: "Acme Dates" });
  await expect(acme).toContainText("Gold");
  await expect(acme).toContainText("Booth B14");
  await expect(acme).toContainText("Tagged: 0");

  await acme.getByRole("button", { name: "Tags", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Items tagged to Acme Dates" })).toBeVisible();
  await page.getByRole("checkbox", { name: "General" }).click();
  await expect(page.getByRole("status")).toContainText("Tag saved.");
  await expect(acme).toContainText("Tagged: 1");

  await page.goto(base + "/quests");
  await expect(page.getByRole("region", { name: "General" })).toContainText(
    "Presented by Acme Dates",
  );

  await page.goto(base.replace("/en/", "/ar/") + "/sponsors");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByRole("heading", { name: "الرعاة", level: 1 })).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: "تمور أكمي" })).toContainText(
    "الكشك B14",
  );

  await page.goto(base + "/sponsors");
  await page
    .getByRole("listitem")
    .filter({ hasText: "Acme Dates" })
    .getByRole("button", { name: "Delete" })
    .click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("General");
  await dialog.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByRole("listitem").filter({ hasText: "Acme Dates" })).toHaveCount(0);
});
