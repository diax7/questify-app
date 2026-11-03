import { expect, test, type Page } from "@playwright/test";
import { openBuilder } from "#e2e/builder.ts";
import { CONTROL_PORT } from "#e2e/paths.ts";

const CONTROL = `http://127.0.0.1:${CONTROL_PORT}`;
const API = "http://127.0.0.1:4100";
const DEFAULT_ORDER = [
  "banner",
  "notices",
  "code",
  "account",
  "operator",
  "invitations",
  "streak",
  "dailyChallenge",
  "dailyWord",
  "events",
  "quests",
];

/**
 * The console's Questify home editor (T-713, FR-1838), English and Arabic: the blocks move and hide, the always-shown ones
 * cannot be hidden, the phone follows the draft before anything is saved, a save reaches the public configuration at
 * once, and a revert puts it back. The banner's slides are written, checked (a title, an https link) and previewed. The
 * layout is one document for the platform, so only the desktop run edits it (the layout check walks the page on both).
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

/** What any app downloads before it signs in: the blocks Questify home draws and its banner. */
async function published(page: Page): Promise<{ blocks: string[]; banner: unknown[] }> {
  const response = await page.request.get(`${API}/v1/config`);
  expect(response.status()).toBe(200);
  return ((await response.json()) as { questifyHome: { blocks: string[]; banner: unknown[] } })
    .questifyHome;
}

const blockRows = (page: Page) =>
  page.getByRole("list", { name: /^(Blocks|الأقسام)$/ }).getByRole("listitem");
const phoneBlocks = (page: Page) => page.getByTestId("home-preview").locator("[data-block]");
const phoneOrder = async (page: Page): Promise<(string | null)[]> =>
  Promise.all((await phoneBlocks(page).all()).map((row) => row.getAttribute("data-block")));

test("blocks move and hide, the phone follows, a save reaches the apps at once, and a revert puts it back", async ({
  page,
}, info) => {
  test.skip(info.project.name === "phone", "the layout is one document for the platform");
  test.setTimeout(120_000);
  await asAdmin(page, info.project.name);
  await page.goto("/en/console/home");
  await expect(page.getByRole("heading", { name: "Questify home", level: 1 })).toBeVisible();

  await expect(blockRows(page)).toHaveCount(11);
  await expect(blockRows(page).getByText("Always shown")).toHaveCount(6);
  await expect(page.getByRole("checkbox", { name: "Show My events" })).toBeDisabled();
  await expect(page.getByRole("checkbox", { name: "Show Daily streak" })).toBeEnabled();
  expect(await phoneOrder(page)).toEqual(DEFAULT_ORDER);

  await page.getByRole("button", { name: "Move Daily word earlier" }).click();
  await page.getByRole("checkbox", { name: "Show Daily streak" }).uncheck();
  const expected = [
    "banner",
    "notices",
    "code",
    "account",
    "operator",
    "invitations",
    "dailyWord",
    "dailyChallenge",
    "events",
    "quests",
  ];
  expect(await phoneOrder(page)).toEqual(expected);
  expect(await published(page)).toMatchObject({ blocks: DEFAULT_ORDER });

  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Change saved.")).toBeVisible();
  expect((await published(page)).blocks).toEqual(expected);
  await page.reload();
  await expect(blockRows(page).nth(7)).toContainText("Daily word");
  await expect(page.getByRole("checkbox", { name: "Show Daily streak" })).not.toBeChecked();
  await expect(page.getByText("Changed", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Go back on the last change to Questify home" }).click();
  await expect(page.getByText("Went back to the earlier version.")).toBeVisible();
  expect((await published(page)).blocks).toEqual(DEFAULT_ORDER);
  await expect.poll(() => phoneOrder(page)).toEqual(DEFAULT_ORDER);
  await expectNoSidewaysScroll(page);
});

test("the banner's slides are written, checked and shown on the phone, and a revert takes them away", async ({
  page,
}, info) => {
  test.skip(info.project.name === "phone", "the layout is one document for the platform");
  test.setTimeout(120_000);
  await asAdmin(page, info.project.name);
  await page.goto("/en/console/home");
  await expect(page.getByText("No slides yet")).toBeVisible();

  await page.getByRole("button", { name: "Edit Banner" }).click();
  await page.getByRole("button", { name: "Add slide" }).click();
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await expect(page.getByText("Slide 1 needs a title in Arabic or English.")).toBeVisible();

  await page.getByLabel("Title (English)", { exact: true }).fill("Tickets are open");
  await page.getByLabel("Line under the title (English)").fill("Book before Friday");
  await expect(page.getByTestId("home-preview-slide")).toContainText("Tickets are open");
  await expect(page.getByTestId("home-preview-slide")).toContainText("Book before Friday");

  const tap = page.getByLabel("Tap opens");
  await expect(tap.locator("option")).toHaveText(["Nothing", "A web link"]);
  await tap.selectOption({ label: "A web link" });
  await page.getByLabel("Link", { exact: true }).fill("http://questify.example/tickets");
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await expect(page.getByText("Enter a full link that starts with https.")).toBeVisible();
  await page.getByLabel("Link", { exact: true }).fill("https://questify.example/tickets");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Change saved.")).toBeVisible();

  const shown = await published(page);
  expect(shown.banner).toMatchObject([
    {
      title: { en: "Tickets are open" },
      action: { type: "link", url: "https://questify.example/tickets" },
    },
  ]);

  await page.getByRole("button", { name: "Go back on the last change to Questify home" }).click();
  await expect(page.getByText("Went back to the earlier version.")).toBeVisible();
  expect((await published(page)).banner).toEqual([]);
  await expect(page.getByText("No slides yet")).toBeVisible();
  await expectNoSidewaysScroll(page);
});

test("in Arabic the editor reads right to left and a block moves, saves and goes back", async ({
  page,
}, info) => {
  test.skip(info.project.name === "phone", "the layout is one document for the platform");
  test.setTimeout(120_000);
  await asAdmin(page, info.project.name);
  await page.goto("/ar/console/home");
  await expect(
    page.getByRole("heading", { name: "صفحة كويستفاي الرئيسية", level: 1 }),
  ).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(blockRows(page).getByText("يظهر دائمًا")).toHaveCount(6);
  await expect(page.getByTestId("home-preview")).toHaveAttribute("dir", "rtl");

  await page.getByRole("button", { name: "أخّر تحدي اليوم" }).click();
  expect((await phoneOrder(page)).slice(7, 9)).toEqual(["dailyWord", "dailyChallenge"]);
  await page.getByRole("button", { name: "حفظ", exact: true }).click();
  await expect(page.getByText("حُفظ التغيير.")).toBeVisible();
  expect((await published(page)).blocks.slice(7, 9)).toEqual(["dailyWord", "dailyChallenge"]);

  await page
    .getByRole("button", { name: "التراجع عن آخر تغيير في صفحة كويستفاي الرئيسية" })
    .click();
  await expect(page.getByText("عدنا إلى ما قبل التغيير.")).toBeVisible();
  expect((await published(page)).blocks).toEqual(DEFAULT_ORDER);
  await expectNoSidewaysScroll(page);
});
