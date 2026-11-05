import { expect, test, type Page } from "@playwright/test";
import { openBuilder } from "#e2e/builder.ts";
import { consoleRequest, makeAdmin } from "#e2e/hosts.ts";

/**
 * The console's switches and tuning numbers (T-703, FR-1769, FR-1770), desktop and phone, English and Arabic. The platform
 * settings are shared by every spec, so each test puts back what it changed before it ends.
 */
async function asAdmin(page: Page, project: string): Promise<void> {
  await openBuilder(page, project);
  const eventId = page.url().split("/").at(-2) ?? "";
  await makeAdmin(page, eventId);
  // The switches are shared by every run: start from the app's own, whatever an earlier run left.
  for (const path of ["features/maps", "tuning/rehearsalCap"]) {
    expect((await consoleRequest(page, "DELETE", `/v1/admin/switches/${path}`)).status()).toBe(204);
  }
}

async function expectNoSidewaysScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

async function configOf(page: Page): Promise<Composed> {
  return (await (await page.request.get("/v1/config")).json()) as Composed;
}

type Composed = { features: Record<string, { enabled: boolean; message: unknown }> };

test("in English a feature is switched off with a message the apps read, then put back", async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  await asAdmin(page, info.project.name);
  await page.goto("/en/console/switches");
  await expect(page.getByRole("heading", { name: "Switches and numbers", level: 1 })).toBeVisible();
  const card = page.locator('[data-testid="switch-card"][data-feature="maps"]');
  await expect(card.getByRole("checkbox", { name: "Maps" })).toBeChecked();
  await expect(card.getByLabel("Message for players · Arabic")).toHaveCount(0);

  await card.getByRole("checkbox", { name: "Maps" }).click();
  await expect(page.getByText("Change saved.")).toBeVisible();
  await expect(card.getByRole("checkbox", { name: "Maps" })).not.toBeChecked();
  await expect(card.getByText("Changed")).toBeVisible();

  await card.getByLabel("Message for players · English").fill("Maps are resting.");
  await expect(card.getByRole("button", { name: "Save message" })).toBeDisabled();
  await expect(card.getByText("Check the marked fields before saving.")).toBeVisible();
  await card.getByLabel("Message for players · Arabic").fill("الخرائط في استراحة.");
  await card.getByRole("button", { name: "Save message" }).click();
  await expect(page.getByText("Change saved.")).toBeVisible();

  await expect
    .poll(async () => ((await configOf(page)).features["maps"] ?? {}).message)
    .toEqual({ ar: "الخرائط في استراحة.", en: "Maps are resting." });
  expect((await configOf(page)).features["maps"]?.enabled).toBe(false);

  await card.getByRole("button", { name: "Put Maps back to the original" }).click();
  await expect(card.getByRole("checkbox", { name: "Maps" })).toBeChecked();
  await expect(card.getByText("Changed")).toHaveCount(0);
  await expect
    .poll(async () => (await configOf(page)).features["maps"])
    .toMatchObject({ enabled: true, message: null });
});

test("in English a number is saved inside its range and put back to the default", async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  await asAdmin(page, info.project.name);
  await page.goto("/en/console/switches");
  await page.getByRole("button", { name: "Numbers", exact: true }).click();
  const card = page.locator('[data-testid="number-card"][data-number="rehearsalCap"]');
  const field = card.getByRole("spinbutton", { name: "Most rehearsal accounts per event" });
  await expect(field).toHaveValue("25");

  await field.fill("101");
  await expect(card.getByText("Check the marked fields before saving.")).toBeVisible();
  await expect(card.getByRole("button", { name: "Save" })).toBeDisabled();
  await field.fill("30");
  await card.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Change saved.")).toBeVisible();
  await expect(card.getByText("Changed")).toBeVisible();
  await expect(field).toHaveValue("30");

  await card
    .getByRole("button", { name: "Put Most rehearsal accounts per event back to the original" })
    .click();
  await expect(field).toHaveValue("25");
  await expect(card.getByText("Changed")).toHaveCount(0);
});

test("in Arabic the page mirrors, names every feature, and does not scroll sideways", async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  await asAdmin(page, info.project.name);
  await page.goto("/ar/console/switches");
  await expect(page.getByRole("heading", { name: "المفاتيح والأرقام", level: 1 })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByTestId("switch-card").first()).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "الخرائط" })).toBeChecked();
  await expectNoSidewaysScroll(page);
  await page.getByRole("button", { name: "الأرقام", exact: true }).click();
  await expect(page.getByTestId("number-card")).toHaveCount(6);
  await expectNoSidewaysScroll(page);
});
