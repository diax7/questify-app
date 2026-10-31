import { expect, test } from "@playwright/test";
import { openBuilder } from "#e2e/builder.ts";

test("adds, renames, orders and deletes maps and places pins on the board, in English and in Arabic", async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  await openBuilder(page, info.project.name);
  const base = page.url().replace("/quests", "").replace("/ar/", "/en/");
  await page.goto(base + "/maps");
  await expect(page.getByRole("heading", { name: "Maps", level: 1 })).toBeVisible();

  await page.getByRole("button", { name: "Add a map" }).click();
  await page.getByLabel("Name in Arabic", { exact: true }).fill("الطابق الأول");
  await page.getByLabel("Name in English", { exact: true }).fill("Floor 1");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const floor = page.getByRole("listitem").filter({ hasText: "Floor 1" });
  await expect(floor).toContainText("Pins: 0");

  await floor.getByRole("button", { name: "Pins", exact: true }).click();
  const board = page.getByRole("group", { name: "Map board: Floor 1" });
  await board.click({ position: { x: 120, y: 60 } });
  await expect(page.getByLabel("Across (%)", { exact: true })).not.toHaveValue("50");
  await page.getByLabel("Type", { exact: true }).selectOption("amenity");
  await page.getByLabel("Amenity", { exact: true }).selectOption("prayer");
  await page.getByRole("button", { name: "Save pin" }).click();
  await expect(page.getByRole("status")).toContainText("Pin saved.");
  await expect(board.getByRole("button", { name: "Prayer room" })).toBeVisible();

  await page.getByRole("button", { name: "Add a pin" }).click();
  await page.getByRole("button", { name: "Save pin" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Write a name in at least one language." }),
  ).toBeVisible();
  await page.getByLabel("Pin name in English").fill("Booth 12");
  await page.getByLabel("Across (%)", { exact: true }).fill("70");
  await page.getByRole("button", { name: "Save pin" }).click();
  await expect(board.getByRole("button", { name: "Booth 12" })).toBeVisible();

  await page
    .getByRole("listitem")
    .filter({ hasText: "Prayer room" })
    .getByRole("button", { name: "Delete" })
    .click();
  const askPin = page.getByRole("alertdialog");
  await expect(askPin).toContainText("The pin leaves the map for players now.");
  await askPin.getByRole("button", { name: "Cancel" }).click();
  await expect(board.getByRole("button", { name: "Prayer room" })).toBeVisible();
  await page
    .getByRole("listitem")
    .filter({ hasText: "Prayer room" })
    .getByRole("button", { name: "Delete" })
    .click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
  await expect(board.getByRole("button", { name: "Prayer room" })).toHaveCount(0);
  await floor.getByRole("button", { name: "Pins", exact: true }).click();
  await expect(floor).toContainText("Pins: 1");

  await floor.getByRole("button", { name: "Rename" }).click();
  await page.getByLabel("Name in English", { exact: true }).fill("Ground floor");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const ground = page.getByRole("listitem").filter({ hasText: "Ground floor" });
  await expect(ground).toBeVisible();

  await page.getByRole("button", { name: "Add a map" }).click();
  await page.getByLabel("Name in English", { exact: true }).fill("Outdoor area");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const outdoor = page.getByRole("listitem").filter({ hasText: "Outdoor area" });
  await outdoor.getByRole("button", { name: "Move up" }).click();
  await expect(page.getByRole("listitem").first()).toContainText("Outdoor area");

  await page.goto(base.replace("/en/", "/ar/") + "/maps");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByRole("heading", { name: "الخرائط", level: 1 })).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: "الطابق الأول" })).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: "Outdoor area" })).toBeVisible();

  await page.goto(base + "/maps");
  await page
    .getByRole("listitem")
    .filter({ hasText: "Outdoor area" })
    .getByRole("button", { name: "Delete" })
    .click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
  await expect(page.getByRole("listitem").filter({ hasText: "Outdoor area" })).toHaveCount(0);
});
