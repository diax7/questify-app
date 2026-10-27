import { expect, test, type Locator, type Page } from "@playwright/test";
import { openBuilder } from "#e2e/builder.ts";
import { CONTROL_PORT } from "#e2e/paths.ts";

const CONTROL = `http://127.0.0.1:${CONTROL_PORT}`;

/**
 * The console's Ranking seasons (T-408c, FR-1786, ADR-323), desktop and phone, Arabic and English. The database is
 * shared by both runs, so each run seeds its own players and its own past months (by project and test), which keeps
 * the counts of those months exact; the current month gets two players per test (eight in all, so they all stay in its
 * top 10) and is only checked for their order. Players are put straight on a board, as the XP writer would have left it.
 */

async function expectNoSidewaysScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

async function asAdmin(page: Page, project: string): Promise<void> {
  await openBuilder(page, project);
  const eventId = page.url().split("/").at(-2) ?? "";
  expect((await page.request.post(`${CONTROL}/make-admin`, { data: { eventId } })).status()).toBe(
    204,
  );
}

/**
 * New players, one per entry of `points`, on the board `monthsAgo` months back (0: this month) and with that XP as
 * their lifetime XP; answers that month and the players' levels, in order.
 */
async function seedBoard(
  page: Page,
  tag: string,
  monthsAgo: number,
  points: readonly number[],
): Promise<{ month: string; names: string[]; levels: number[] }> {
  const names = points.map((_, index) => `szn_${tag}_${String(index + 1)}`);
  const response = await page.request.post(`${CONTROL}/season-board`, {
    data: { usernames: names, points, monthsAgo },
  });
  expect(response.status()).toBe(200);
  const { month, levels } = (await response.json()) as { month: string; levels: number[] };
  return { month, names, levels };
}

/** `YYYY-MM` moved back by whole months. */
function monthsBefore(month: string, count: number): string {
  const [year, number] = month.split("-").map(Number);
  return new Date(Date.UTC(year ?? 0, (number ?? 1) - 1 - count, 1)).toISOString().slice(0, 7);
}

/** A month as the English page names it. */
const label = (month: string): string =>
  new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", month: "long", year: "numeric" }).format(
    new Date(`${month}-01T00:00:00Z`),
  );
const seasonOf = (page: Page, month: string): Locator =>
  page.locator(`[data-testid="season"][data-month="${month}"]`);
const usernamesIn = (season: Locator): Promise<string[]> =>
  season.getByTestId("season-row").locator("[dir=auto]").allTextContents();

test("in Arabic an admin opens the current month, then a past month's top 10 and an empty month", async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  await asAdmin(page, info.project.name);
  const mine = info.project.name;
  const monthsAgo = mine === "phone" ? 3 : 2;
  const now = await seedBoard(page, `${mine}_now_ar`, 0, [9300, 9200]);
  const past = await seedBoard(page, `${mine}_old_ar`, monthsAgo, [5000, 4000, 3000]);
  const gap = monthsBefore(now.month, 1);

  await page.goto("/ar/console");
  await page.getByRole("link", { name: "مواسم الترتيب" }).click();
  await expect(page.getByRole("heading", { name: "مواسم الترتيب", level: 1 })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");

  // It opens on the current month, newest first, with its top players in order.
  const current = seasonOf(page, now.month);
  await expect(page.getByTestId("season").first()).toHaveAttribute("data-month", now.month);
  await expect(current).toContainText("الحالي");
  await expect(current.getByRole("button")).toHaveAttribute("aria-expanded", "true");
  await expect(current.getByTestId("season-row").first()).toBeVisible();
  expect((await usernamesIn(current)).filter((name) => now.names.includes(name))).toEqual(
    now.names,
  );
  const first = current.getByTestId("season-row").filter({ hasText: now.names[0] ?? "" });
  await expect(first).toContainText(/9\D?300 XP في الشهر/);
  await expect(first).toContainText(`المستوى الإجمالي: ${String(now.levels[0])}`);
  await expectNoSidewaysScroll(page);

  // A past month has its own count and top 10; opening it closes the current one.
  const old = seasonOf(page, past.month);
  await expect(old).toContainText("اللاعبون في الترتيب: 3");
  await expect(old.getByTestId("season-row")).toHaveCount(0);
  await old.getByRole("button").click();
  await expect(old.getByRole("button")).toHaveAttribute("aria-expanded", "true");
  await expect(current.getByRole("button")).toHaveAttribute("aria-expanded", "false");
  await expect(current.getByTestId("season-row")).toHaveCount(0);
  await expect(old.getByTestId("season-row")).toHaveCount(3);
  expect(await usernamesIn(old)).toEqual(past.names);
  await expect(old.getByTestId("season-row").first()).toContainText(/5\D?000 XP في الشهر/);
  await expectNoSidewaysScroll(page);

  // A month nobody played is listed with no players and says so.
  const quiet = seasonOf(page, gap);
  await expect(quiet).toContainText("اللاعبون في الترتيب: 0");
  await quiet.getByRole("button").click();
  await expect(quiet.getByText("لا يوجد لاعبون في ترتيب", { exact: false })).toBeVisible();
  await expect(quiet.getByTestId("season-row")).toHaveCount(0);

  // Closing the open month leaves every month closed.
  await quiet.getByRole("button").click();
  await expect(page.getByTestId("season").locator('[aria-expanded="true"]')).toHaveCount(0);
});

test("in English the page is read only, marks the current month and shows a past top 10", async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  await asAdmin(page, info.project.name);
  const mine = info.project.name;
  const monthsAgo = mine === "phone" ? 5 : 4;
  const now = await seedBoard(page, `${mine}_now_en`, 0, [9600, 9500]);
  const past = await seedBoard(page, `${mine}_old_en`, monthsAgo, [800, 700, 600]);

  await page.goto("/en/console/seasons");
  await expect(page.getByRole("heading", { name: "Ranking seasons", level: 1 })).toBeVisible();
  await expect(page.getByText("There is no manual reset.", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: /reset/i })).toHaveCount(0);

  const current = seasonOf(page, now.month);
  await expect(current).toContainText(label(now.month));
  await expect(current.getByText("Current", { exact: true })).toBeVisible();
  await expect(
    current.getByRole("heading", { name: `Top 10 in ${label(now.month)}` }),
  ).toBeVisible();
  await expect(
    current.getByTestId("season-row").filter({ hasText: now.names[0] ?? "" }),
  ).toContainText(/9\D?600 XP in the month/);
  await expectNoSidewaysScroll(page);

  const old = seasonOf(page, past.month);
  await expect(old).toContainText(label(past.month));
  await expect(old).toContainText("Ranked players: 3");
  await expect(old.getByText("Current", { exact: true })).toHaveCount(0);
  await old.getByRole("button").click();
  await expect(old.getByRole("heading", { name: `Top 10 in ${label(past.month)}` })).toBeVisible();
  expect(await usernamesIn(old)).toEqual(past.names);
  await expect(old.getByTestId("season-row").nth(2)).toContainText("600 XP in the month");
  await expect(old.getByTestId("season-row").nth(2)).toContainText(
    `Lifetime level: ${String(past.levels[2])}`,
  );
  await expectNoSidewaysScroll(page);

  // The console home links to the page.
  await page.goto("/en/console");
  await page.getByRole("link", { name: "Ranking seasons" }).click();
  await expect(page).toHaveURL(/\/en\/console\/seasons$/);
});

test("an organizer who is not a Questify admin does not find the page", async ({ page }, info) => {
  await openBuilder(page, info.project.name);
  const response = await page.goto("/ar/console/seasons");
  expect(response?.status()).toBe(404);
});
