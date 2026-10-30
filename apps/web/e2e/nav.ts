import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Opens the dashboard's menu when it is closed. On a phone the navigation and the Home, My account and Sign out links
 * wait behind the Menu button (ADR-364); on a desktop they are always shown and this does nothing. It clicks again until
 * the menu says it is open, since a click before the page hydrates does nothing.
 */
export async function openMenu(page: Page): Promise<void> {
  const menu = page.getByRole("button", { name: /^(Menu|القائمة)$/ });
  if (!(await menu.isVisible())) {
    return;
  }
  await expect(async () => {
    if ((await menu.getAttribute("aria-expanded")) !== "true") {
      await menu.click();
    }
    await expect(menu).toHaveAttribute("aria-expanded", "true", { timeout: 1000 });
  }).toPass();
}

const OUTSIDE_THE_DIALOG = "header a, header button, nav a, nav button, a[href='#main']";

/**
 * Proves an open modal dialog shuts out the rest of the page: tabbing forward and back never leaves it, and no link or
 * button of the top bar, the navigation or the skip link can take focus.
 */
export async function expectModal(page: Page, dialog: Locator): Promise<void> {
  const steps = ["Tab", "Tab", "Tab", "Tab", "Shift+Tab", "Shift+Tab", "Shift+Tab", "Shift+Tab"];
  for (const key of steps) {
    await page.keyboard.press(key);
    const inside = await dialog.evaluate(
      (element) =>
        document.activeElement === document.body || element.contains(document.activeElement),
    );
    expect(inside, `${key} moved focus out of the dialog`).toBe(true);
  }
  const reachable = await page.evaluate((selector) => {
    const links = [...document.querySelectorAll<HTMLElement>(selector)];
    return links
      .filter((link) => {
        link.focus();
        return document.activeElement === link;
      })
      .map((link) => link.textContent.trim());
  }, OUTSIDE_THE_DIALOG);
  expect(reachable, "top bar, navigation or skip link took focus under the dialog").toEqual([]);
}
