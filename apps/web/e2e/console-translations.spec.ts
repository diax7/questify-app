import { expect, test, type Locator, type Page } from "@playwright/test";
import { openBuilder } from "#e2e/builder.ts";
import { openMenu } from "#e2e/nav.ts";
import { CONTROL_PORT } from "#e2e/paths.ts";

const CONTROL = `http://127.0.0.1:${CONTROL_PORT}`;
const WEB = "http://localhost:3100";

/**
 * The console's App texts (T-702, FR-1765, FR-1766, FR-1757), desktop and phone, English and Arabic. The database is
 * shared by the runs, so each project edits its own key and every test leaves it as shipped. The key's shipped texts are
 * the ones in `MESSAGES`; the app downloads an edit as `GET /v1/translations`.
 */
const OWN = {
  desktop: { key: "common.retry", en: "Try again", ar: "إعادة المحاولة" },
  phone: { key: "common.continue", en: "Continue", ar: "متابعة" },
} as const;

const ownOf = (project: string) => (project === "phone" ? OWN.phone : OWN.desktop);

async function asAdmin(page: Page, project: string): Promise<void> {
  await openBuilder(page, project);
  const eventId = page.url().split("/").at(-2) ?? "";
  expect((await page.request.post(`${CONTROL}/make-admin`, { data: { eventId } })).status()).toBe(
    204,
  );
}

async function expectNoSidewaysScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

const rowOf = (page: Page, key: string): Locator =>
  page.locator(`[data-testid="translation-row"][data-key="${key}"]`);

/** What the app would download right now for a key. */
async function downloaded(page: Page, language: "ar" | "en", key: string): Promise<unknown> {
  const response = await page.request.get("/v1/translations");
  const bundle = (await response.json()) as Record<string, Record<string, string>>;
  return bundle[language]?.[key];
}

async function search(page: Page, text: string): Promise<void> {
  await page.getByLabel(/^(Search keys and texts|ابحث في المفاتيح والنصوص)$/).fill(text);
}

/** Puts the key back to the shipped text through the API, whatever state a failed test left it in. */
test.afterEach(async ({ page }, info) => {
  const { key } = ownOf(info.project.name);
  await page.request.put(`/v1/admin/translations/${key}`, {
    data: { ar: "", en: "" },
    headers: { origin: WEB },
  });
});

test("in English an admin finds a text, edits it, sees the shipped text kept, and reverts it", async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  await asAdmin(page, info.project.name);
  const { key, en, ar } = ownOf(info.project.name);
  await page.goto("/en/console/translations");
  await expect(page.getByRole("heading", { name: "App texts", level: 1 })).toBeVisible();
  await search(page, key);
  const row = rowOf(page, key);
  await expect(row).toBeVisible();
  await expect(row.getByTestId("cell-en")).toContainText(en);
  await expect(row.getByTestId("cell-ar")).toContainText(ar);

  await row.getByRole("button", { name: `Edit ${key}` }).click();
  await row.getByTestId("box-en").getByRole("textbox").fill("Retry now");
  await row.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText(`Saved ${key}.`)).toBeVisible();
  await expect(row.getByTestId("cell-en")).toContainText("Retry now");
  await expect(row.getByTestId("cell-en")).toContainText(`Shipped text: ${en}`);
  await expect(row.getByTestId("cell-en").getByText("Changed", { exact: true })).toBeVisible();
  await expect(row.getByTestId("cell-ar")).toContainText(ar);
  expect(await downloaded(page, "en", key)).toBe("Retry now");
  expect(await downloaded(page, "ar", key)).toBeUndefined();

  await page.getByRole("button", { name: "Changed", exact: true }).click();
  await expect(row).toBeVisible();

  await row.getByRole("button", { name: `Revert ${key} to the shipped text` }).click();
  await expect(page.getByText(`${key} is back to the shipped text.`)).toBeVisible();
  await expect(row.getByTestId("cell-en")).not.toContainText("Retry now");
  expect(await downloaded(page, "en", key)).toBeUndefined();
  await expectNoSidewaysScroll(page);
});

test("a placeholder cannot be lost: the chip flags it, the save waits, and a click puts it back", async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  await asAdmin(page, info.project.name);
  await page.goto("/en/console/translations");
  await search(page, "console.seasons.xp");
  const row = rowOf(page, "console.seasons.xp");
  await row.getByRole("button", { name: "Edit console.seasons.xp" }).click();
  const box = row.getByTestId("box-en");
  const save = row.getByRole("button", { name: "Save", exact: true });
  const chip = box.getByRole("button", { name: "Insert {xp}" });
  await expect(chip).toHaveAttribute("data-state", "present");

  await box.getByRole("textbox").fill("XP in the month");
  await expect(chip).toHaveAttribute("data-state", "missing");
  await expect(save).toBeDisabled();
  await expect(box).toContainText("Keep every name in braces");
  await chip.click();
  await expect(box.getByRole("textbox")).toHaveValue(/\{xp\}/);
  await expect(chip).toHaveAttribute("data-state", "present");
  await expect(save).toBeEnabled();

  await box.getByRole("textbox").fill("{xp} XP in the month, {oops}");
  await expect(box.getByText("{oops} Not allowed")).toBeVisible();
  await expect(save).toBeDisabled();

  await row.getByRole("button", { name: "Discard edit" }).click();
  await expect(row.getByTestId("cell-en")).toContainText("{xp} XP in the month");
  await expect(row.getByTestId("cell-en").getByText("Changed", { exact: true })).toHaveCount(0);
  await expectNoSidewaysScroll(page);
});

test("in Arabic the page reads right to left and an Arabic text is edited in a right-to-left box", async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  await asAdmin(page, info.project.name);
  const { key, ar, en } = ownOf(info.project.name);
  await page.goto("/ar/console/translations");
  await expect(page.getByRole("heading", { name: "نصوص التطبيق", level: 1 })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await search(page, key);
  const row = rowOf(page, key);
  await expect(row.getByTestId("cell-ar").locator("[dir]").first()).toHaveAttribute("dir", "rtl");
  await expect(row.getByTestId("cell-en").locator("[dir]").first()).toHaveAttribute("dir", "ltr");
  await expect(row.getByTestId("cell-ar")).toContainText(ar);

  await row.getByRole("button", { name: `تعديل ${key}` }).click();
  await expect(row.getByTestId("box-ar").getByRole("textbox")).toHaveAttribute("dir", "rtl");
  await expect(row.getByTestId("box-en").getByRole("textbox")).toHaveAttribute("dir", "ltr");
  await row.getByTestId("box-ar").getByRole("textbox").fill("أعد المحاولة الآن");
  await row.getByRole("button", { name: "حفظ", exact: true }).click();
  await expect(page.getByText(`حُفظ ${key}.`)).toBeVisible();
  await expect(row.getByTestId("cell-ar")).toContainText("أعد المحاولة الآن");
  await expect(row.getByTestId("cell-ar")).toContainText(`النص الأصلي: ${ar}`);
  await expect(row.getByTestId("cell-en")).toContainText(en);
  expect(await downloaded(page, "ar", key)).toBe("أعد المحاولة الآن");

  await row.getByRole("button", { name: `إرجاع ${key} إلى النص الأصلي` }).click();
  await expect(page.getByText(`عاد ${key} إلى النص الأصلي.`)).toBeVisible();
  expect(await downloaded(page, "ar", key)).toBeUndefined();
  await expectNoSidewaysScroll(page);
});

test("a legal text is shown but cannot be edited", async ({ page }, info) => {
  test.setTimeout(120_000);
  await asAdmin(page, info.project.name);
  await page.goto("/en/console/translations");
  await search(page, "signIn.consentBody");
  const row = rowOf(page, "signIn.consentBody");
  await expect(row).toBeVisible();
  await expect(row.getByText("Read-only", { exact: true })).toBeVisible();
  await expect(row.getByTestId("cell-en")).not.toBeEmpty();
  await expect(row.getByRole("button", { name: /^(Edit|Revert) / })).toHaveCount(0);
  await expectNoSidewaysScroll(page);
});

test("leaving with an edit that is not saved asks whether to keep, discard or save it", async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  await asAdmin(page, info.project.name);
  const { key, en } = ownOf(info.project.name);
  await page.goto("/en/console/translations");
  await search(page, key);
  const row = rowOf(page, key);
  await row.getByRole("button", { name: `Edit ${key}` }).click();
  const box = row.getByTestId("box-en").getByRole("textbox");
  const dialog = page.getByRole("alertdialog", { name: "Save your edit?" });
  await box.fill("Unsaved wording");

  // A step inside the page (the filter) asks first; keeping the edit leaves everything as it was.
  await page.getByRole("button", { name: "Changed", exact: true }).click();
  await expect(dialog).toContainText(`${key} has an edit that is not saved.`);
  await dialog.getByRole("button", { name: "Keep editing" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(box).toHaveValue("Unsaved wording");
  await page.getByRole("button", { name: "Changed", exact: true }).click();
  await dialog.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(row).toHaveCount(0);
  await page.getByRole("button", { name: "All", exact: true }).click();
  await expect(rowOf(page, key).getByTestId("cell-en")).toContainText(en);
  expect(await downloaded(page, "en", key)).toBeUndefined();

  // A link to another console page asks too, and discarding carries on to it.
  await row.getByRole("button", { name: `Edit ${key}` }).click();
  await box.fill("Unsaved again");
  await openMenu(page);
  await page.locator('a[href="/en/console/usage"]').click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Keep editing" }).click();
  await expect(page).toHaveURL(/\/console\/translations/);
  await expect(box).toHaveValue("Unsaved again");
  await page.locator('a[href="/en/console/usage"]').click();
  await dialog.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(page).toHaveURL(/\/console\/usage/);
});

test("narrowing by screen lists only that screen's texts", async ({ page }, info) => {
  test.setTimeout(120_000);
  await asAdmin(page, info.project.name);
  await page.goto("/en/console/translations");
  await page.getByLabel("Screen", { exact: true }).selectOption("nav");
  await expect(rowOf(page, "nav.home")).toBeVisible();
  const keys = await page
    .getByTestId("translation-row")
    .evaluateAll((rows) => rows.map((element) => element.getAttribute("data-key") ?? ""));
  expect(keys.length).toBeGreaterThan(3);
  expect(keys.every((entry) => entry.startsWith("nav."))).toBe(true);
  await expectNoSidewaysScroll(page);
});
