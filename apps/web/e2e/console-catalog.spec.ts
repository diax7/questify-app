import { expect, test, type Page } from "@playwright/test";
import { openBuilder } from "#e2e/builder.ts";
import { CONTROL_PORT } from "#e2e/paths.ts";

const CONTROL = `http://127.0.0.1:${CONTROL_PORT}`;

/**
 * The console's catalog editors (T-709b, FR-1403), desktop and phone, English and Arabic: event templates, achievements,
 * level titles and the gem shop. The database is shared by the runs, so each project edits its own rows and every test
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

test("in Arabic the catalog reads right to left and an achievement's name is edited while its thresholds are only shown", async ({
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
  await expect(card.getByLabel("برونزية")).toHaveCount(0);
  await expect(tiers).toHaveText(shown);
  const name = card.getByLabel("الاسم · العربية");
  await name.fill("");
  await expect(card.getByRole("button", { name: "حفظ" })).toBeDisabled();
  await name.fill(`${own.ar} جدًا`);
  await card.getByRole("button", { name: "حفظ" }).click();
  await expect(page.getByText("حُفظ التغيير.")).toBeVisible();
  await expect(card.getByTestId("cell-ar").getByText(`${own.ar} جدًا`)).toBeVisible();
  await card.getByRole("button", { name: `التراجع عن آخر تغيير في ${own.ar} جدًا` }).click();
  await expect(page.getByText("عدنا إلى ما قبل التغيير.")).toBeVisible();
  await expect(card.getByTestId("cell-ar").getByText(own.ar, { exact: true })).toBeVisible();
  await expect(tiers).toHaveText(shown);
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
