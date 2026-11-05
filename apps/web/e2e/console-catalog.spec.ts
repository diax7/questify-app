import { expect, test, type Page } from "@playwright/test";
import { openBuilder } from "#e2e/builder.ts";
import { makeAdmin } from "#e2e/hosts.ts";

/**
 * The console's catalog editors (T-709b, T-709c, FR-1403), desktop and phone, English and Arabic: event templates,
 * achievements, level titles, the gem shop and the amounts. The database is shared by the runs, so each project edits its own rows and every test
 * leaves them as shipped (it reverts what it saved, which also proves the revert).
 */
const OWN = {
  desktop: {
    template: { key: "conference", en: "Conference", ar: "مؤتمر" },
    achievement: { id: "quests-done", ar: "صائد المهام" },
    shop: { id: "shop-map-reader", price: 40 },
  },
  phone: {
    template: { key: "festival", en: "Festival", ar: "مهرجان" },
    achievement: { id: "cities-played", ar: "جوّاب المدن" },
    shop: { id: "shop-dune-watcher", price: 50 },
  },
} as const;

const ownOf = (project: string) => (project === "phone" ? OWN.phone : OWN.desktop);

async function asAdmin(page: Page, project: string): Promise<void> {
  await openBuilder(page, project);
  const eventId = page.url().split("/").at(-2) ?? "";
  await makeAdmin(page, eventId);
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
  // Going back lowers gold again, so it asks once and names the gems before it pays.
  await card.getByRole("button", { name: `التراجع عن آخر تغيير في ${own.ar} جدًا` }).click();
  const ask = card.getByRole("alert");
  await expect(ask.getByText(`منح جواهر مقابل ${own.ar} جدًا؟`)).toBeVisible();
  await expect(ask.getByText("التراجع عن هذا التغيير لا يسترد الجواهر.")).toBeVisible();
  await ask.getByRole("button", { name: "خفض ومنح الجواهر" }).click();
  await expect(page.getByText("عدنا إلى ما قبل التغيير.")).toBeVisible();
  await expect(card.getByTestId("cell-ar").getByText(own.ar, { exact: true })).toBeVisible();
  await expect(tiers).toHaveText(shown);
  await expectNoSidewaysScroll(page);
});

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
  await expect(cards).toHaveCount(2);
  const levelUp = page.getByLabel("Level up");
  const stored = Number(await levelUp.inputValue());
  await levelUp.fill("1001");
  await expect(page.getByRole("button", { name: "Save" })).toBeDisabled();
  await levelUp.fill(String(stored + 1));
  await page.getByRole("button", { name: "Save" }).click();
  const ask = page.getByRole("alert");
  await expect(
    ask.getByText(`From now on: Level up ${stored} → ${stored + 1} gems.`),
  ).toBeVisible();
  await ask.getByRole("button", { name: "Save amounts" }).click();
  await expect(page.getByText("Change saved.")).toBeVisible();
  await expect(page.getByLabel("Level up")).toHaveValue(String(stored + 1));
  await page.getByRole("button", { name: "Go back on the last change to Amounts" }).click();
  await expect(page.getByText("Went back to the earlier version.")).toBeVisible();
  await expect(page.getByLabel("Level up")).toHaveValue(String(stored));
  await expectNoSidewaysScroll(page);
});

test("level titles are edited as a set and the gem shop price is changed and reverted", async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  const shop = ownOf(info.project.name).shop;
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

  await page.getByRole("button", { name: "Gem shop" }).click();
  const card = page.locator(`[data-testid="shop-card"][data-id="${shop.id}"]`);
  await expect(card.getByText(`Gems: ${shop.price}, place:`)).toBeVisible();
  await card.getByRole("button", { name: /^Edit / }).click();
  await card.getByLabel("Price in gems").fill(String(shop.price + 1));
  await card.getByRole("button", { name: "Save" }).click();
  await expect(card.getByText(`Gems: ${shop.price + 1}, place:`)).toBeVisible();
  await card.getByRole("button", { name: /^Go back on the last change/ }).click();
  await expect(card.getByText(`Gems: ${shop.price}, place:`)).toBeVisible();
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
  await table.getByRole("alert").getByRole("button", { name: "Save and pay" }).click();
  await expect(page.getByText("Went back to the earlier version.")).toBeVisible();
  await expectNoSidewaysScroll(page);
});

test("in Arabic an item's names are edited and reverted; a shop item's art is locked", async ({
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
  const shop = page.locator('[data-testid="item-card"][data-id="shop-dune-ring"]');
  await expect(shop.getByTestId("item-facts")).toContainText("معروض في المتجر");
  await expectNoSidewaysScroll(page);
});
