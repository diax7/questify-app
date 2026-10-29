import { expect, type Page } from "@playwright/test";

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
