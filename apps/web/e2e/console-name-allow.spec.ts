import { expect, test } from "@playwright/test";
import { openBuilder } from "#e2e/builder.ts";
import { CONTROL_PORT } from "#e2e/paths.ts";

const CONTROL = `http://127.0.0.1:${CONTROL_PORT}`;

/**
 * The console's full-name allow-list (FR-1779, ADR-817), desktop and phone: an admin allows a word, finds it with the
 * filters and stops allowing it after one confirmation; a list word is refused with the API's reason; the Arabic page
 * reads right to left.
 */
test("an admin allows, finds and removes a name word, and sees a list word refused; the Arabic page reads right to left", async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  await openBuilder(page, info.project.name);
  const eventId = page.url().split("/").at(-2) ?? "";
  expect((await page.request.post(`${CONTROL}/make-admin`, { data: { eventId } })).status()).toBe(
    204,
  );
  const word = `zq${Date.now().toString(36).replace(/[0-9]/g, "x")}`;
  await page.goto("/en/console/name-allow");
  await expect(page.getByRole("heading", { name: "Allowed name words", level: 1 })).toBeVisible();
  const list = page.getByRole("region", { name: "Allowed words" });
  await list.getByLabel("Word", { exact: true }).fill("fuck");
  await list.getByRole("button", { name: "Allow word" }).click();
  await expect(list.getByText("That word is itself on the word lists")).toBeVisible();
  await list.getByLabel("Word", { exact: true }).fill(word);
  await list.getByRole("button", { name: "Allow word" }).click();
  await expect(page.getByText("Word allowed.")).toBeVisible();
  await list.getByRole("searchbox").fill(word);
  const line = list.getByRole("listitem").filter({ hasText: word });
  await expect(line).toHaveCount(1);
  await expect(line).toContainText("English");
  await list.getByLabel("Language").selectOption({ label: "Arabic" });
  await expect(list.getByText("No allowed words.")).toBeVisible();
  await list.getByLabel("Language").selectOption({ label: "English" });
  await line.getByRole("button", { name: "Remove" }).click();
  await line.getByRole("alert").getByRole("button", { name: "Remove" }).click();
  await expect(page.getByText("Word no longer allowed.")).toBeVisible();
  await expect(list.getByText("No allowed words.")).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);

  await page.goto("/ar/console/name-allow");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(
    page.getByRole("heading", { name: "كلمات مسموحة في الأسماء", level: 1 }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "الكلمات المسموحة", level: 2 })).toBeVisible();
});
