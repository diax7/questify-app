import { expect, test } from "@playwright/test";
import { openBuilder } from "#e2e/builder.ts";
import { CONTROL_PORT } from "#e2e/paths.ts";

test("pages pending schedules beyond 30 and cancels both the nearest and last in English and RTL", async ({
  page,
  request,
}, info) => {
  test.setTimeout(120_000);
  await openBuilder(page, info.project.name);
  const base = page.url().replace("/quests", "").replace("/ar/", "/en/");
  const eventId = base.split("/events/")[1];
  const changed = await request.post("http://127.0.0.1:" + CONTROL_PORT + "/invitation-event", {
    data: { eventId, days: 60 },
  });
  expect(changed.status()).toBe(204);
  const path =
    "/v1/organizers/" +
    base.split("/organizers/")[1]?.split("/")[0] +
    "/events/" +
    eventId +
    "/announcements";
  for (let day = 2; day <= 32; day += 1) {
    const made = await page.evaluate(
      async ({ endpoint, offset }) => {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json", "Idempotency-Key": crypto.randomUUID() },
          body: JSON.stringify({
            titleAr: "إعلان مجدول",
            titleEn: "Schedule " + offset,
            bodyAr: "في القاعة",
            bodyEn: "In the hall",
            sendAt: new Date(Date.now() + offset * 86400_000).toISOString(),
          }),
        });
        return response.status;
      },
      { endpoint: path, offset: day },
    );
    expect(made).toBe(201);
  }
  await page.goto(base + "/announcements");
  const pending = page.getByRole("region", { name: "Pending schedules — earliest first" });
  await expect(pending.getByRole("listitem")).toHaveCount(30);
  await expect(pending.getByRole("listitem").first()).toContainText("Schedule 2");
  await expect(page.getByRole("button", { name: "Previous schedules" })).toBeDisabled();
  await page.getByLabel("Title in English").fill("Keep this draft");
  await page.getByRole("button", { name: "Next schedules" }).click();
  await expect(pending.getByRole("listitem")).toHaveCount(1);
  await expect(pending).toContainText("Schedule 32");
  await expect(page.getByLabel("Title in English")).toHaveValue("Keep this draft");
  await expect(page.getByRole("button", { name: "Next schedules" })).toBeDisabled();
  await pending.getByRole("button", { name: "Cancel it", exact: true }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Cancel it", exact: true })
    .click();
  await expect(pending.getByRole("listitem")).toHaveCount(0);
  await page.getByRole("button", { name: "Previous schedules" }).click();
  await expect(pending.getByRole("listitem")).toHaveCount(30);
  await pending
    .getByRole("listitem")
    .first()
    .getByRole("button", { name: "Cancel it", exact: true })
    .click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Cancel it", exact: true })
    .click();
  await expect(pending.getByRole("listitem")).toHaveCount(29);
  await page.goto((base + "/announcements").replace("/en/", "/ar/"));
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByRole("navigation", { name: "صفحات الإعلانات المجدولة" })).toBeVisible();
  await expect(page.getByRole("button", { name: "الصفحة التالية", exact: true })).toBeDisabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

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
