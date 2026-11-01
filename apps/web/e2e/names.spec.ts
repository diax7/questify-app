import { expect, test, type Page } from "@playwright/test";
import { openBuilder } from "#e2e/builder.ts";

/**
 * How an event names its players (T-615, FR-1842): a full name needs the Full name join field, the preview redraws a row
 * for the players and for the staff before anything is saved, the setting survives a reload, and the page reads right to
 * left in Arabic with the username kept left to right.
 */

async function openJoining(page: Page, project: string, language: "en" | "ar"): Promise<void> {
  await openBuilder(page, project);
  const eventUrl = page.url().replace(/\/quests$/, "");
  await page.goto(`${eventUrl.replace("/ar/", `/${language}/`)}/joining`);
}

test("a full name needs its field, is previewed for players and staff, saved and kept", async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  await openJoining(page, info.project.name, "en");
  await expect(page.getByRole("heading", { name: "Joining", level: 1 })).toBeVisible();

  const names = page.getByRole("region", { name: "Names" });
  const display = names.getByRole("group", { name: "How players are named" });
  await expect(display.getByRole("radio", { name: "Username" })).toBeChecked();
  await expect(display.getByRole("radio", { name: "Full name" })).toBeDisabled();
  await expect(names.getByText("Add the Full name join field first.")).toBeVisible();

  await page.getByRole("button", { name: "Add a field" }).click();
  await page.getByRole("button", { name: "Save the fields" }).click();
  await expect(page.getByText("The fields are saved.")).toBeVisible();
  await expect(display.getByRole("radio", { name: "Full name" })).toBeEnabled();
  await expect(names.getByText("Add the Full name join field first.")).toBeHidden();

  await display.getByRole("radio", { name: "Both" }).check();
  const audience = names.getByRole("group", { name: "Who sees the full name" });
  await audience.getByRole("radio", { name: "All players" }).check();
  const preview = names.getByRole("term");
  await expect(preview).toHaveText(["What players see", "What staff see"]);
  const rows = names.getByRole("definition");
  await expect(rows).toHaveText(["Sara Ahmed · @sara_q", "Sara Ahmed · @sara_q"]);

  await audience.getByRole("radio", { name: "Event staff only" }).check();
  await expect(rows).toHaveText(["@sara_q", "Sara Ahmed · @sara_q"]);
  await display.getByRole("radio", { name: "Full name" }).check();
  await expect(rows).toHaveText(["@sara_q", "Sara Ahmed"]);

  await names.getByRole("button", { name: "Save" }).click();
  await expect(names.getByText("Name settings saved.")).toBeVisible();
  await page.reload();
  await expect(display.getByRole("radio", { name: "Full name" })).toBeChecked();
  await expect(audience.getByRole("radio", { name: "Event staff only" })).toBeChecked();
  await expect(rows).toHaveText(["@sara_q", "Sara Ahmed"]);

  await display.getByRole("radio", { name: "Username" }).check();
  await expect(audience).toBeHidden();
  await expect(rows).toHaveText(["@sara_q", "@sara_q"]);
});

test("the names section reads right to left in Arabic, the username kept left to right", async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  await openJoining(page, info.project.name, "ar");
  const names = page.getByRole("region", { name: "الأسماء" });
  await expect(names).toBeVisible();
  const display = names.getByRole("group", { name: "كيف يظهر اللاعب" });
  await expect(display.getByRole("radio", { name: "اسم المستخدم" })).toBeChecked();
  await expect(names.getByText("أضف أولًا حقل «الاسم الكامل» في حقول الانضمام.")).toBeVisible();
  const rows = names.getByRole("definition");
  await expect(rows).toHaveText(["@sara_q", "@sara_q"]);
  await expect(rows.first().locator("bdi")).toHaveAttribute("dir", "ltr");
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflow).toBe(false);
});
