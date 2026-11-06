import { expect, test, type Page } from "@playwright/test";
import { openBuilder } from "#e2e/builder.ts";
import { CONTROL_PORT } from "#e2e/paths.ts";

const CONTROL = `http://127.0.0.1:${CONTROL_PORT}`;
const REVIEWER_PHONE = "0500000731";

/**
 * The console's App Review demo (T-710, FR-1406, FR-1407, FR-1736), desktop and phone: an admin creates the demo with the
 * reviewer's phone, prepares it for a build and sees the new fixed code once, and closes the window. The demo is one row
 * for the whole platform, so the first run creates it and the next one finds it; every run prepares and closes it.
 */
async function asAdmin(page: Page, project: string): Promise<void> {
  await openBuilder(page, project);
  const eventId = new URL(page.url()).pathname.split("/")[5] ?? "";
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

/** Creates the demo when this run is the first to find none. */
async function createIfMissing(page: Page): Promise<void> {
  const none = page.getByText("The demo has not been created yet.");
  const facts = page.getByText(/^Join code: /);
  await expect(none.or(facts)).toBeVisible();
  if (await none.isVisible()) {
    await page.getByLabel("Reviewer phone").fill(REVIEWER_PHONE);
    await page.getByRole("button", { name: "Create the demo" }).click();
    await expect(page.getByText("Demo created.")).toBeVisible();
  }
  await expect(facts).toBeVisible();
  await expect(page.getByText("+966500000731")).toBeVisible();
}

test("an admin creates the review demo, prepares it and sees the code once, and closes the window", async ({
  page,
}, info) => {
  test.setTimeout(150_000);
  await asAdmin(page, info.project.name);
  await page.goto("/en/console/review-demo");
  await expect(page.getByRole("heading", { name: "App Review demo" })).toBeVisible();
  await createIfMissing(page);
  await expect(page.getByTestId("readiness-item").first()).toBeVisible();
  await expectNoSidewaysScroll(page);

  await page.getByLabel("App version").fill("1.4.0");
  await page.getByRole("button", { name: "Prepare for review" }).click();
  const asking = page.getByRole("alert").filter({ hasText: "The reviewer account is reset" });
  await asking.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByTestId("review-code")).toHaveCount(0);
  await page.getByRole("button", { name: "Prepare for review" }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: "The reviewer account is reset" })
    .getByRole("button", { name: "Prepare for review" })
    .click();
  await expect(page.getByText("Ready for review.")).toBeVisible();
  const code = page.getByTestId("review-code");
  await expect(code).toHaveText(/^\d{6}$/);
  await expect(page.getByText("Shown once. Paste it into App Store Connect")).toBeVisible();
  await expect(page.getByTestId("review-window")).toContainText("version 1.4.0");
  await expectNoSidewaysScroll(page);

  // The code is shown once: a reload keeps the window open and does not show the code again.
  await page.reload();
  await expect(page.getByTestId("review-window")).toContainText("Open until");
  await expect(page.getByTestId("review-code")).toHaveCount(0);

  await page.getByRole("button", { name: "Close window" }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: "The fixed code stops working" })
    .getByRole("button", { name: "Close window" })
    .click();
  await expect(page.getByText("Window closed.")).toBeVisible();
  await expect(page.getByTestId("review-window")).toHaveText("Closed");
  await expect(page.getByRole("button", { name: "Close window" })).toBeDisabled();
  await expectNoSidewaysScroll(page);
});
