import { expect, test } from "@playwright/test";
import { openBuilder } from "#e2e/builder.ts";
import { makeAdmin } from "#e2e/hosts.ts";
import { CONTROL_PORT } from "#e2e/paths.ts";

const CONTROL = `http://127.0.0.1:${CONTROL_PORT}`;

/**
 * Questify's moderation (T-705b, FR-1404, FR-1414), desktop and phone: a reported quest is in the queue; the admin
 * opens it, unpublishes it with a reason and a note after one confirmation, and the event's quest list shows the
 * organizer why; the admin publishes it again. The Flags page opens, and the Arabic queue reads right to left.
 */
test("an admin unpublishes a reported quest and the organizer sees why", async ({ page }, info) => {
  test.setTimeout(150_000);
  await openBuilder(page, info.project.name);
  const questsUrl = page.url();
  const eventId = questsUrl.split("/").at(-2) ?? "";
  await makeAdmin(page, eventId);
  const title = `Rude quest ${info.project.name} ${Date.now() % 1e6}`;
  const seeded = await page.request.post(`${CONTROL}/reported`, {
    data: {
      eventId,
      nameEn: title,
      usernames: [`rep_${info.project.name.slice(0, 3)}_${Date.now() % 1e6}`],
    },
  });
  expect(seeded.status()).toBe(204);

  await page.goto("/en/console/reports");
  await expect(page.getByRole("heading", { name: "Reports", level: 1 })).toBeVisible();
  const addresses = page.getByRole("region", { name: "Moderation addresses" });
  await addresses.getByLabel("Urgent-report alert email").fill("alerts@questify.test");
  await addresses.getByRole("button", { name: "Save addresses" }).click();
  await expect(addresses.getByRole("status")).toHaveText("Addresses saved.");
  await page.getByRole("link", { name: title }).click();
  await expect(page.getByRole("heading", { name: title, level: 1 })).toBeVisible();
  const targetUrl = page.url();
  const unpublish = page.getByRole("region", { name: "Unpublish" });
  await unpublish.getByLabel("Reason").selectOption({ label: "Offensive" });
  await unpublish.getByLabel("Note the organizer sees").fill("The title insults a group.");
  await unpublish.getByRole("button", { name: "Unpublish" }).click();
  await unpublish.getByRole("alert").getByRole("button", { name: "Unpublish" }).click();
  await expect(page.getByText("The title insults a group.")).toBeVisible();
  await expect(page.getByText("No open reports.")).toBeVisible();

  await page.goto(questsUrl);
  await expect(page.getByText("ألغت Questify نشر هذا: مسيء.", { exact: false })).toBeVisible();

  await page.goto(targetUrl);
  const republish = page.getByRole("region", { name: "Publish again" });
  await republish.getByLabel("Internal note").fill("The organizer fixed the title.");
  await republish.getByRole("button", { name: "Publish again" }).click();
  await republish.getByRole("alert").getByRole("button", { name: "Publish again" }).click();
  await expect(page.getByRole("region", { name: "Unpublish" })).toBeVisible();

  await page.goto("/en/console/flags");
  await expect(page.getByRole("heading", { name: "Flags", level: 1 })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);

  await page.goto("/ar/console/reports");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByRole("heading", { name: "البلاغات", level: 1 })).toBeVisible();
});
