import { expect, test } from "@playwright/test";
import { openBuilder } from "#e2e/builder.ts";
import { expectModal, openMenu } from "#e2e/nav.ts";

/**
 * The two things that cover the dashboard page (ADR-366): a confirmation dialog and, on a phone, the Menu sheet. While
 * either is open the page behind it cannot take focus and Escape closes it. The sheet gives focus back to Menu; the
 * dialog gives it back to its opener (checked in console-questify.spec.ts, since this page's Delete draft button steps
 * aside while its dialog is open and returns afterwards).
 */
test("a confirmation dialog shuts the top bar and navigation out of the keyboard, and Escape closes it", async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  await openBuilder(page, info.project.name);
  await page.goto(page.url().replace(/\/quests$/, ""));
  const topLink = page.locator("header a").first();
  await topLink.focus();
  await expect(topLink, "the check can tell a reachable link from a shut-out one").toBeFocused();

  const opener = page.getByRole("button", { name: "حذف المسودة" });
  await opener.click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("حذف المسودة؟");
  await expectModal(page, dialog);

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeVisible();
});

test("the phone menu makes the page inert, and Escape closes it from anywhere and gives focus back", async ({
  page,
}, info) => {
  test.skip(
    info.project.name !== "phone",
    "The menu is a phone sheet; a desktop shows the column.",
  );
  test.setTimeout(120_000);
  await openBuilder(page, info.project.name);
  const menu = page.getByRole("button", { name: "القائمة", exact: true });
  const main = page.locator("main");

  await openMenu(page);
  await expect(main).toHaveJSProperty("inert", true);
  await page.locator("nav#shell-navigation a").first().focus();
  await expect(page.locator("nav#shell-navigation a").first()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveAttribute("aria-expanded", "false");
  await expect(menu).toBeFocused();
  await expect(main).toHaveJSProperty("inert", false);

  await openMenu(page);
  await expect(menu).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveAttribute("aria-expanded", "false");
  await expect(menu).toBeFocused();
  await expect(main).toHaveJSProperty("inert", false);
});
