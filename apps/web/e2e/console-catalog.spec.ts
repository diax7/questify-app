import { expect, test, type Page } from "@playwright/test";
import { openBuilder } from "#e2e/builder.ts";
import { CONTROL_PORT } from "#e2e/paths.ts";

const CONTROL = `http://127.0.0.1:${CONTROL_PORT}`;

/**
 * The console's catalog editors (T-709b, T-709c, FR-1403), desktop and phone, English and Arabic: event templates,
 * achievements, level titles and the amounts. The database is shared by the runs, so each project edits its own rows and every test
 * leaves them as shipped (it reverts what it saved, which also proves the revert).
 */
const OWN = {
  desktop: {
    template: { key: "conference", en: "Conference", ar: "مؤتمر" },
    achievement: { id: "quests-done", ar: "صائد المهام" },
  },
  phone: {
    template: { key: "festival", en: "Festival", ar: "مهرجان" },
    achievement: { id: "cities-played", ar: "جوّاب المدن" },
  },
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

test("in English a template is edited in place, saved, and reverted, and the cards are equal", async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  const own = ownOf(info.project.name).template;
  await asAdmin(page, info.project.name);
  await page.goto("/en/console/catalog");
  await expect(page.getByRole("heading", { name: "Catalog", level: 1 })).toBeVisible();

  const cards = page.getByTestId("template-card");
  await expect(cards).toHaveCount(4);
  const heights = new Map<number, number[]>();
  for (const box of await Promise.all((await cards.all()).map((card) => card.boundingBox()))) {
    heights.set(Math.round(box?.y ?? 0), [
      ...(heights.get(Math.round(box?.y ?? 0)) ?? []),
      box?.height ?? 0,
    ]);
  }
  for (const row of heights.values()) {
    expect(Math.max(...row) - Math.min(...row)).toBeLessThanOrEqual(1);
  }

  const card = page.locator(`[data-testid="template-card"][data-key="${own.key}"]`);
  await expect(card.getByTestId("cell-en").getByText(own.en, { exact: true })).toBeVisible();
  await card.getByRole("button", { name: `Edit ${own.en}` }).click();
  const setup = card.getByLabel("Setup");
  const stored = await setup.inputValue();
  await setup.fill("{ not json");
  await expect(card.getByRole("button", { name: "Save" })).toBeDisabled();
  await expect(card.getByText("This setup can't be saved:")).toBeVisible();
  await setup.fill(stored);
  await card.getByLabel("Name · English").fill(`${own.en} Plus`);
  await card.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Change saved.")).toBeVisible();
  await expect(card.getByTestId("cell-en").getByText(`${own.en} Plus`)).toBeVisible();
  await expect(card.getByText("Changed", { exact: true })).toBeVisible();

  await card.getByRole("button", { name: `Go back on the last change to ${own.en} Plus` }).click();
  await expect(page.getByText("Went back to the earlier version.")).toBeVisible();
  await expect(card.getByTestId("cell-en").getByText(own.en, { exact: true })).toBeVisible();
  await expectNoSidewaysScroll(page);
});

test("in Arabic the catalog reads right to left; an achievement's name and thresholds are edited, and a lowering asks first", async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  const own = ownOf(info.project.name).achievement;
  await asAdmin(page, info.project.name);
  await page.goto("/ar/console/catalog");
  await expect(page.getByRole("heading", { name: "الكتالوج", level: 1 })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await page.getByRole("button", { name: "الإنجازات" }).click();

  const card = page.locator(`[data-testid="achievement-card"][data-id="${own.id}"]`);
  await expect(card.getByTestId("cell-ar").getByText(own.ar)).toBeVisible();
  const tiers = card.getByTestId("achievement-tiers");
  const shown = await tiers.innerText();
  expect(shown).toContain("برونزية");
  await card.getByRole("button", { name: `تعديل ${own.ar}` }).click();
  const gold = card.getByLabel("ذهبية");
  const storedGold = Number(await gold.inputValue());
  const bronze = card.getByLabel("برونزية");
  const storedBronze = await bronze.inputValue();
  await bronze.fill(String(storedGold));
  await expect(card.getByRole("button", { name: "حفظ" })).toBeDisabled();
  await bronze.fill(storedBronze);
  const name = card.getByLabel("الاسم · العربية");
  await name.fill("");
  await expect(card.getByRole("button", { name: "حفظ" })).toBeDisabled();
  await name.fill(`${own.ar} جدًا`);
  await gold.fill(String(storedGold + 1));
  await card.getByRole("button", { name: "حفظ" }).click();
  await expect(page.getByText("حُفظ التغيير.")).toBeVisible();
  await expect(card.getByTestId("cell-ar").getByText(`${own.ar} جدًا`)).toBeVisible();
  await expect(tiers).toContainText(String(storedGold + 1));
  // Going back lowers gold again, so it asks once and names the XP and the item before it pays.
  await card.getByRole("button", { name: `التراجع عن آخر تغيير في ${own.ar} جدًا` }).click();
  const ask = card.getByRole("alert");
  await expect(ask.getByText(`منح خبرة مقابل ${own.ar} جدًا؟`)).toBeVisible();
  await expect(ask.getByText("التراجع عن هذا التغيير لا يستردها.")).toBeVisible();
  await ask.getByRole("button", { name: "خفض ومنح الخبرة" }).click();
  await expect(page.getByText("عدنا إلى ما قبل التغيير.")).toBeVisible();
  await expect(card.getByTestId("cell-ar").getByText(own.ar, { exact: true })).toBeVisible();
  await expect(tiers).toHaveText(shown);
  await expectNoSidewaysScroll(page);
});

/** The words of the achievement "Unlocks" flow in each language of the console (T-404d). */
const UNLOCKS = {
  en: {
    tab: "Achievements",
    edit: /^Edit /,
    revert: /^Go back on the last change to /,
    saved: "Change saved.",
    reverted: "Went back to the earlier version.",
    save: "Save",
    silver: "Silver",
    none: "No item",
  },
  ar: {
    tab: "الإنجازات",
    edit: /^تعديل /,
    revert: /^التراجع عن آخر تغيير في /,
    saved: "حُفظ التغيير.",
    reverted: "عدنا إلى ما قبل التغيير.",
    save: "حفظ",
    silver: "فضية",
    none: "بلا عنصر",
  },
} as const;

for (const language of ["en", "ar"] as const) {
  test(`in ${language === "en" ? "English" : "Arabic"} an achievement's Unlocks item is changed, removed, and put back by a revert`, async ({
    page,
  }, info) => {
    test.setTimeout(120_000);
    const words = UNLOCKS[language];
    const own = ownOf(info.project.name).achievement;
    await asAdmin(page, info.project.name);
    await page.goto(`/${language}/console/catalog`);
    await expect(page.locator("html")).toHaveAttribute("dir", language === "ar" ? "rtl" : "ltr");
    await page.getByRole("button", { name: words.tab }).click();

    const card = page.locator(`[data-testid="achievement-card"][data-id="${own.id}"]`);
    const line = card.getByTestId("achievement-unlocks");
    await expect(line).toBeVisible();
    const stored = await line.innerText();

    await card.getByRole("button", { name: words.edit }).click();
    const item = card.getByTestId("achievement-item");
    const tier = card.getByTestId("achievement-item-tier");
    const kept = await item.inputValue();
    const options = await item
      .locator("option")
      .evaluateAll((all) => all.map((option) => (option as HTMLOptionElement).value));
    // A level's item, or another achievement's, is never offered: only the free ones and the one held.
    expect(options.filter((value) => value.startsWith("level-"))).toEqual([]);
    const other = options.find((value) => value !== "" && value !== kept);
    expect(other, "an unassigned item to move to").toBeDefined();

    await item.selectOption(other ?? "");
    await tier.selectOption("silver");
    await card.getByRole("button", { name: words.save, exact: true }).click();
    await expect(page.getByText(words.saved)).toBeVisible();
    await expect(line).toContainText(words.silver);
    await expect(line).not.toHaveText(stored);
    // A revert puts back the item and the tier the card held before the change.
    await card.getByRole("button", { name: words.revert }).click();
    await expect(page.getByText(words.reverted)).toBeVisible();
    await expect(line).toHaveText(stored);

    await card.getByRole("button", { name: words.edit }).click();
    await item.selectOption("");
    await expect(item.locator("option:checked")).toHaveText(words.none);
    await expect(tier).toBeDisabled();
    await card.getByRole("button", { name: words.save, exact: true }).click();
    await expect(line).toHaveCount(0);
    await card.getByRole("button", { name: words.revert }).click();
    await expect(line).toHaveText(stored);
    await expectNoSidewaysScroll(page);
  });
}

test("the amounts are two equal cards; a save names each changed amount once and is reverted", async ({
  page,
}, info) => {
  // One document for the whole platform: only the desktop run edits it, so two runs never cross.
  test.skip(info.project.name === "phone", "the amounts are one shared document");
  test.setTimeout(120_000);
  await asAdmin(page, info.project.name);
  await page.goto("/en/console/catalog");
  await page.getByRole("button", { name: "Amounts" }).click();
  const cards = page.getByTestId("amounts-card");
  await expect(cards).toHaveCount(1);
  const gold = page.getByLabel("Gold tier");
  const stored = Number(await gold.inputValue());
  await gold.fill("1001");
  await expect(page.getByRole("button", { name: "Save" })).toBeDisabled();
  await gold.fill(String(stored + 1));
  await page.getByRole("button", { name: "Save" }).click();
  const ask = page.getByRole("alert");
  await expect(ask.getByText(`From now on: Gold tier ${stored} → ${stored + 1} XP.`)).toBeVisible();
  await ask.getByRole("button", { name: "Save amounts" }).click();
  await expect(page.getByText("Change saved.")).toBeVisible();
  await expect(page.getByLabel("Gold tier")).toHaveValue(String(stored + 1));
  await page.getByRole("button", { name: "Go back on the last change to Amounts" }).click();
  const revert = page.getByRole("alert").filter({ hasText: "Go back to the earlier amounts?" });
  await expect(revert.getByText("Nothing already paid changes.")).toBeVisible();
  await revert.getByRole("button", { name: "Cancel" }).click();
  await expect(revert).toHaveCount(0);
  await expect(page.getByLabel("Gold tier")).toHaveValue(String(stored + 1));
  await page.getByRole("button", { name: "Go back on the last change to Amounts" }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: "Go back to the earlier amounts?" })
    .getByRole("button", { name: "Go back", exact: true })
    .click();
  await expect(page.getByText("Went back to the earlier version.")).toBeVisible();
  await expect(page.getByLabel("Gold tier")).toHaveValue(String(stored));
  await expectNoSidewaysScroll(page);
});

test("level titles are edited as a set", async ({ page }, info) => {
  test.setTimeout(120_000);
  await asAdmin(page, info.project.name);
  await page.goto("/en/console/catalog");

  await page.getByRole("button", { name: "Level titles" }).click();
  const titles = page.getByTestId("level-titles");
  await expect(titles.getByTestId("title-row")).toHaveCount(6);
  await titles.getByRole("button", { name: "Edit Level titles" }).click();
  await titles.getByRole("button", { name: "Add a title" }).click();
  await expect(titles.getByRole("button", { name: "Save" })).toBeDisabled();
  await titles.getByRole("button", { name: "Discard" }).click();
  await expect(titles.getByTestId("title-row")).toHaveCount(6);

  await expectNoSidewaysScroll(page);
});

test("the XP table shows each level and its reward; a raise is saved after its summary and the lowering revert asks to pay", async ({
  page,
}, info) => {
  // One document for the whole platform: only the desktop run edits it, so two runs never cross.
  test.skip(info.project.name === "phone", "the XP table is one shared document");
  test.setTimeout(120_000);
  await asAdmin(page, info.project.name);
  await page.goto("/en/console/catalog");
  await page.getByRole("button", { name: "XP table" }).click();
  const table = page.getByTestId("xp-table");
  await expect(table.getByTestId("xp-level")).toHaveCount(30);
  await table.getByRole("button", { name: "Edit XP table" }).click();
  const top = table.locator('[data-testid="xp-level-edit"][data-level="30"]');
  const start = top.getByLabel("Starts at (XP)");
  const stored = Number(await start.inputValue());
  await start.fill(String(stored + 1));
  await table.getByRole("button", { name: "Save", exact: true }).click();
  const ask = table.getByRole("alert");
  await expect(ask.getByText("Save the XP table?")).toBeVisible();
  await ask.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Change saved.")).toBeVisible();
  await table.getByRole("button", { name: "Go back on the last change to XP table" }).click();
  // The revert names the levels it lowers (the API's refusal), not only that it cannot be undone.
  await expect(table.getByTestId("xp-lowering")).toContainText("levels 30 start");
  await table.getByRole("alert").getByRole("button", { name: "Save and pay" }).click();
  await expect(page.getByText("Went back to the earlier version.")).toBeVisible();
  await expectNoSidewaysScroll(page);
});

test("in Arabic an item's names are edited and reverted; an achievement item names its source", async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  const id = info.project.name === "phone" ? "level-28" : "level-29";
  await asAdmin(page, info.project.name);
  await page.goto("/ar/console/catalog");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await page.getByRole("button", { name: "العناصر" }).click();
  const card = page.locator(`[data-testid="item-card"][data-id="${id}"]`);
  await card.getByRole("button", { name: /^تعديل / }).click();
  const english = card.getByLabel("الاسم · الإنجليزية");
  const stored = await english.inputValue();
  await english.fill(`${stored} II`);
  await card.getByRole("button", { name: "حفظ" }).click();
  await expect(card.getByText(`${stored} II`)).toBeVisible();
  await card.getByRole("button", { name: /^التراجع عن آخر تغيير/ }).click();
  await expect(card.getByText(stored, { exact: true })).toBeVisible();
  const earned = page.locator('[data-testid="item-card"][data-id="shop-dune-ring"]');
  await expect(earned).toContainText("إنجاز");
  await expectNoSidewaysScroll(page);
});
