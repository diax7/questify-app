import { expect, test, type Page } from "@playwright/test";
import { openBuilder } from "#e2e/builder.ts";
import { CONTROL_PORT } from "#e2e/paths.ts";

const CONTROL = `http://127.0.0.1:${CONTROL_PORT}`;
const API = "http://127.0.0.1:4100";
const SHIPPED = ["join", "quests", "points", "prizes"];

/**
 * The console's intro-cards page (T-802b, FR-1803), English and Arabic: the four cards move and hide, the last shown card
 * cannot be hidden (Save waits), a save reaches the public configuration at once, and a revert puts it back. The layout is
 * one document for the platform, so only the desktop run edits it (the layout check walks the page on both).
 */
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

/** What any app downloads before it signs in: the cards the intro plays, in order. */
async function published(page: Page): Promise<string[]> {
  const response = await page.request.get(`${API}/v1/config`);
  expect(response.status()).toBe(200);
  return ((await response.json()) as { playerIntro: { cards: string[] } }).playerIntro.cards;
}

const cardRows = (page: Page) =>
  page.getByRole("list", { name: /^(Cards|البطاقات)$/ }).getByRole("listitem");

test("cards move and hide, the last one cannot be hidden, a save reaches the apps at once, and a revert puts it back", async ({
  page,
}, info) => {
  test.skip(info.project.name === "phone", "the intro is one document for the platform");
  test.setTimeout(120_000);
  await asAdmin(page, info.project.name);
  await page.goto("/en/console/intro");
  await expect(page.getByRole("heading", { name: "Intro cards", level: 1 })).toBeVisible();

  await expect(cardRows(page)).toHaveCount(4);
  await expect(cardRows(page).getByText("Always shown")).toHaveCount(0);
  await expect(cardRows(page).first()).toContainText("Join an event");
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();

  await page.getByRole("button", { name: "Move Win prizes and grow your profile earlier" }).click();
  await page.getByRole("checkbox", { name: "Show Earn points and climb the ranking" }).uncheck();
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
  expect(await published(page)).toEqual(SHIPPED);

  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Change saved.")).toBeVisible();
  expect(await published(page)).toEqual(["join", "quests", "prizes"]);
  await page.reload();
  await expect(page.getByText("Changed", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("checkbox", { name: "Show Earn points and climb the ranking" }),
  ).not.toBeChecked();

  await page.getByRole("button", { name: "Go back on the last change to Intro cards" }).click();
  await expect(page.getByText("Went back to the earlier version.")).toBeVisible();
  expect(await published(page)).toEqual(SHIPPED);
  await expectNoSidewaysScroll(page);
});

test("hiding every card is refused before anything is sent", async ({ page }, info) => {
  test.skip(info.project.name === "phone", "the intro is one document for the platform");
  test.setTimeout(120_000);
  await asAdmin(page, info.project.name);
  await page.goto("/en/console/intro");
  await expect(cardRows(page)).toHaveCount(4);

  const switches = page.getByRole("checkbox", { name: /^Show / });
  for (let at = 0; at < 4; at += 1) {
    await switches.nth(at).uncheck();
  }
  await expect(page.getByText("Keep at least one card shown.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();

  await switches.nth(2).check();
  await expect(page.getByText("Keep at least one card shown.")).toBeHidden();
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
  expect(await published(page)).toEqual(SHIPPED);
});

test("in Arabic the page reads right to left and a card moves, saves and goes back", async ({
  page,
}, info) => {
  test.skip(info.project.name === "phone", "the intro is one document for the platform");
  test.setTimeout(120_000);
  await asAdmin(page, info.project.name);
  await page.goto("/ar/console/intro");
  await expect(page.getByRole("heading", { name: "بطاقات التعريف", level: 1 })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(cardRows(page)).toHaveCount(4);

  await page.getByRole("button", { name: /^أخّر / }).first().click();
  await page.getByRole("button", { name: "حفظ", exact: true }).click();
  await expect(page.getByText("حُفظ التغيير.")).toBeVisible();
  expect(await published(page)).toEqual(["quests", "join", "points", "prizes"]);

  await page.getByRole("button", { name: "التراجع عن آخر تغيير في بطاقات التعريف" }).click();
  await expect(page.getByText("عدنا إلى ما قبل التغيير.")).toBeVisible();
  expect(await published(page)).toEqual(SHIPPED);
  await expectNoSidewaysScroll(page);
});
