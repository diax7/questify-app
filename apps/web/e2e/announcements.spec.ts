import { expect, test } from "@playwright/test";
import { openBuilder } from "#e2e/builder.ts";
import { CONTROL_PORT } from "#e2e/paths.ts";

test("previews in both languages, schedules in the event zone, lists and cancels without a channel selector", async ({
  page,
  request,
}, info) => {
  test.setTimeout(90_000);
  await openBuilder(page, info.project.name);
  const base = page
    .url()
    .replace(/\/quests$/, "")
    .replace("/ar/", "/en/");
  const eventId = /\/events\/([0-9a-f-]{36})/.exec(base)?.[1];
  const moved = await request.post("http://127.0.0.1:" + CONTROL_PORT + "/event-status", {
    data: { eventId, status: "live" },
  });
  expect(moved.status()).toBe(204);
  await page.goto(base + "/announcements");
  await expect(page.getByRole("heading", { level: 1, name: "Announcements" })).toBeVisible();
  await expect(page.getByText("No announcements yet.")).toBeVisible();
  await page.getByLabel("Title in Arabic").fill("الغداء جاهز");
  await page.getByLabel("Title in English").fill("Lunch is ready");
  await page.getByLabel("Text in Arabic").fill("الغداء في القاعة");
  await page.getByLabel("Text in English").fill("Lunch in the hall");
  await expect(page.getByRole("heading", { name: "In Arabic" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "In English" })).toBeVisible();
  await page.getByLabel("Text in English").fill("example.com");
  await expect(page.getByText(/Links, email addresses/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Send the announcement", exact: true }),
  ).toBeDisabled();
  await page.getByLabel("Text in English").fill("Lunch in the hall");
  await page.getByLabel("When to send").selectOption("later");
  const local = new Date(Date.now() + 3 * 60 * 60_000 + 10 * 60_000).toISOString().slice(0, 16);
  await page.getByLabel("Send at").fill(local);
  await page.getByRole("button", { name: "Schedule the announcement", exact: true }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("It will be sent");
  await dialog.getByRole("button", { name: "Schedule the announcement", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("status")).toHaveText("The announcement is scheduled.");
  await expect(page.getByRole("listitem").filter({ hasText: "Lunch is ready" })).toContainText(
    "Scheduled",
  );
  await page.getByRole("button", { name: "Cancel it", exact: true }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Cancel it", exact: true })
    .click();
  await expect(page.getByRole("status")).toHaveText("The announcement is cancelled.");
  await expect(page.getByRole("listitem").filter({ hasText: "Lunch is ready" })).toContainText(
    "Cancelled",
  );
  await expect(page.getByRole("combobox")).toHaveCount(1);
  const player = await request.post("http://127.0.0.1:" + CONTROL_PORT + "/player-token", {
    data: { eventId, usernames: ["announce_" + info.project.name + "_" + Date.now()] },
  });
  expect(player.status()).toBe(200);
  await page.getByLabel("Title in Arabic").fill("الغداء الآن");
  await page.getByLabel("Title in English").fill("Lunch now");
  await page.getByLabel("Text in Arabic").fill("القاعة");
  await page.getByLabel("Text in English").fill("The hall");
  await page.getByRole("button", { name: "Send the announcement", exact: true }).click();
  await expect(page.getByRole("alertdialog")).toContainText("It will reach 1");
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Send the announcement", exact: true })
    .click();
  await expect(page.getByRole("status")).toHaveText("The announcement is on its way.");
  await expect(page.getByRole("listitem").filter({ hasText: "Lunch now" })).toContainText("Sent");
  await page.goto((base + "/announcements").replace("/en/", "/ar/"));
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByRole("heading", { level: 1, name: "الإعلانات" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});
