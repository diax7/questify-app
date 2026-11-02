import { expect, test } from "@playwright/test";
import { openBuilder } from "#e2e/builder.ts";
import { CONTROL_PORT } from "#e2e/paths.ts";

const CONTROL = `http://127.0.0.1:${CONTROL_PORT}`;

/**
 * The console's word lists (T-705, FR-1779), desktop and phone: an admin adds a word, finds it with the filters, and
 * removes it after one confirmation; the Arabic page reads right to left.
 */
test("an admin adds, finds and removes a list word; the Arabic page reads right to left", async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  await openBuilder(page, info.project.name);
  const eventId = page.url().split("/").at(-2) ?? "";
  expect((await page.request.post(`${CONTROL}/make-admin`, { data: { eventId } })).status()).toBe(
    204,
  );
  const word = `zq${Date.now().toString(36).replace(/[0-9]/g, "x")}`;
  await page.goto("/en/console/word-lists");
  await expect(page.getByRole("heading", { name: "Word lists", level: 1 })).toBeVisible();
  const lists = page.getByRole("region", { name: "Words" });
  await lists.getByLabel("Word", { exact: true }).fill(word);
  await lists.getByLabel("Language").first().selectOption({ label: "English" });
  await lists.getByRole("button", { name: "Add word" }).click();
  await expect(page.getByText("Word added.")).toBeVisible();
  await lists.getByRole("searchbox").fill(word);
  const line = lists.getByRole("listitem").filter({ hasText: word });
  await expect(line).toHaveCount(1);
  await line.getByRole("button", { name: "Remove" }).click();
  await line.getByRole("alert").getByRole("button", { name: "Remove" }).click();
  await expect(page.getByText("Word removed.")).toBeVisible();
  await expect(lists.getByText("No words.")).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);

  await page.goto("/ar/console/word-lists");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByRole("heading", { name: "قوائم الكلمات", level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "أسماء محجوزة", level: 2 })).toBeVisible();
});
