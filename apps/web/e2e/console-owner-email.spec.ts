import { expect, test, type Page } from "@playwright/test";
import { makeAdmin } from "#e2e/hosts.ts";
import { BUILDER_PASSWORD, openBuilder } from "#e2e/builder.ts";
import { codeFor, linkFor } from "#e2e/mail.ts";

const REASON = "Owner called back on the number on file";

/** The organizer and event ids of the builder page a run just opened (`…/organizers/{id}/events/{id}/quests`). */
function idsOf(page: Page): { organizerId: string; eventId: string } {
  const parts = new URL(page.url()).pathname.split("/");
  return { organizerId: parts[3] ?? "", eventId: parts[5] ?? "" };
}

/**
 * The owner email change (T-701b, FR-1784), desktop and phone: an admin starts it on another organizer's page after
 * the confirmation; the owner opens the emailed link, types the code and the password, and the console shows the
 * change. The confirm page reads right to left in Arabic.
 */
test("an admin starts an owner email change and the owner confirms it with the code and password", async ({
  page,
  browser,
}, info) => {
  test.setTimeout(240_000);
  const ownerContext = await browser.newContext({
    baseURL: info.project.use.baseURL ?? "http://localhost:3100",
  });
  const ownerPage = await ownerContext.newPage();
  await openBuilder(ownerPage, info.project.name);
  const other = idsOf(ownerPage);
  await openBuilder(page, info.project.name);
  const mine = idsOf(page);
  await makeAdmin(page, mine.eventId);

  await page.goto(`/en/console/organizers/${other.organizerId}`);
  const card = page.getByRole("region", { name: "Owner sign-in email" });
  const moved = `moved.${info.project.name}.${Date.now()}@riyadh.test`;
  await card.getByLabel("New email").fill(moved);
  await card.getByLabel("How you checked identity").selectOption({ label: "Identity document" });
  await card.getByLabel("Reason").fill(REASON);
  await card.getByRole("button", { name: "Change sign-in email" }).click();
  await expect(card.getByText("no other organizers", { exact: false })).toBeVisible();
  await card.getByRole("alert").getByRole("button", { name: "Change sign-in email" }).click();
  await expect(page.getByRole("status")).toHaveText("The code was sent to the new email.");
  await expect(card.getByText(`Waiting for the owner to confirm ${moved}`)).toBeVisible();

  const link = await linkFor(moved);
  const code = await codeFor(moved);
  await ownerPage.goto(link.replace(/^https?:\/\/[^/]+/, ""));
  await expect(
    ownerPage.getByRole("heading", { name: "Confirm your new sign-in email" }),
  ).toBeVisible();
  await ownerPage.getByLabel("Code from the email").fill(code);
  await ownerPage.getByLabel("Current password").fill(BUILDER_PASSWORD);
  await ownerPage.getByRole("button", { name: "Confirm" }).click();
  await expect(ownerPage.getByRole("status")).toHaveText(`Done. Sign in with ${moved}.`);
  const overflow = await ownerPage.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);

  await page.reload();
  await expect(card.getByText(`Changed to ${moved}`, { exact: false })).toBeVisible();
  await ownerContext.close();
});

test("the Arabic confirm page without a link reads right to left and says the link is not valid", async ({
  page,
}) => {
  await page.goto("/ar/email-change");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByRole("heading", { name: "تأكيد بريد الدخول الجديد" })).toBeVisible();
  await expect(page.getByText("الرابط غير صالح. افتحه من البريد مرة أخرى.")).toBeVisible();
});
