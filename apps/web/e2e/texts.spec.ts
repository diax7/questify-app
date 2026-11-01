import { expect, test, type Page } from "@playwright/test";
import { openBuilder } from "#e2e/builder.ts";

/**
 * An event's renamed labels (T-614, FR-1843): the approved names are listed with the platform's text as the placeholder,
 * typing redraws the phone in either language before anything is saved, a bracketed name the label does not have stops the
 * save, a saved label survives a reload, and a reset (or a blank box) returns to the platform's text.
 */

async function openTexts(page: Page, project: string, language: "en" | "ar"): Promise<string> {
  await openBuilder(page, project);
  const eventUrl = page.url().replace(/\/quests$/, "");
  await page.goto(`${eventUrl.replace("/ar/", `/${language}/`)}/texts`);
  return eventUrl.replace("/ar/", "/en/");
}

test("a label is renamed in both languages, previewed, saved and reset", async ({ page }, info) => {
  test.setTimeout(120_000);
  await openTexts(page, info.project.name, "en");
  await expect(page.getByRole("heading", { name: "App labels", level: 1 })).toBeVisible();

  const rewards = page.getByRole("group", { name: "Rewards", exact: true });
  const english = rewards.getByLabel("English");
  const arabic = rewards.getByLabel("Arabic");
  const save = page.getByRole("button", { name: "Save labels" });
  const bar = page
    .getByRole("region", { name: "Home", exact: true })
    .getByRole("list", { name: "Bottom bar" })
    .getByRole("listitem");
  await expect(english).toHaveAttribute("placeholder", "Rewards");
  await expect(arabic).toHaveAttribute("placeholder", "الجوائز");
  await expect(save).toBeDisabled();
  await expect(bar).toHaveText(["Home", "Quests", "Scan", "Rewards", "Profile"]);

  await english.fill("Prizes");
  await arabic.fill("الهدايا");
  await expect(bar).toHaveText(["Home", "Quests", "Scan", "Prizes", "Profile"]);
  await expect(rewards.getByText("Default: Rewards")).toBeVisible();
  await page.getByRole("button", { name: "Arabic", exact: true }).click();
  await expect(
    page
      .getByRole("region", { name: "الرئيسية", exact: true })
      .getByRole("list", { name: "الشريط السفلي" })
      .getByRole("listitem"),
  ).toHaveText(["الرئيسية", "مهام", "المسح", "الهدايا", "حسابي"]);
  await page.getByRole("button", { name: "English", exact: true }).click();

  await english.fill("Prizes {points}");
  await expect(page.getByText("Remove the curly brackets from Rewards (English).")).toBeVisible();
  await expect(save).toBeDisabled();
  await english.fill("Prizes");

  await save.click();
  await expect(page.getByText("Labels saved.")).toBeVisible();
  await page.reload();
  await expect(english).toHaveValue("Prizes");
  await expect(arabic).toHaveValue("الهدايا");
  await expect(bar).toHaveText(["Home", "Quests", "Scan", "Prizes", "Profile"]);

  await page.getByRole("button", { name: "Reset Rewards to default" }).click();
  await expect(english).toHaveValue("");
  await expect(arabic).toHaveValue("");
  await expect(bar).toHaveText(["Home", "Quests", "Scan", "Rewards", "Profile"]);
  await save.click();
  await expect(page.getByText("Labels saved.")).toBeVisible();
  await page.reload();
  await expect(english).toHaveValue("");
  await expect(bar).toHaveText(["Home", "Quests", "Scan", "Rewards", "Profile"]);
});

test("the labels page reads right to left in Arabic, with the currency word beside the names", async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  await openTexts(page, info.project.name, "ar");
  await expect(page.getByRole("heading", { name: "تسميات التطبيق", level: 1 })).toBeVisible();
  const rewards = page.getByRole("group", { name: "الجوائز", exact: true });
  await expect(rewards.getByLabel("العربية")).toHaveAttribute("dir", "rtl");
  await expect(rewards.getByLabel("الإنجليزية")).toHaveAttribute("dir", "ltr");
  await expect(page.getByText("كلمة العملة")).toBeVisible();
  await expect(page.getByRole("link", { name: "تعديل كلمة العملة" })).toBeVisible();
});
