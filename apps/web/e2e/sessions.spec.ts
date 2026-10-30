import { expect, test } from "@playwright/test";
import { openBuilder } from "#e2e/builder.ts";

const IMPORT_FILE = [
  "type,title_en,title_ar,start,end,place_en,place_ar,speakers,description_en,description_ar,access,seats",
  "workshop,Imported workshop,ورشة مستوردة,2030-11-01 12:00,2030-11-01 13:00,Hall 2,القاعة 2,Sara;Omar,,,registration,30",
  "talk,,,2030-11-01 12:00,2030-11-01 13:00,,,,,,,",
].join("\r\n");

test("adds, edits, closes, imports, exports and deletes sessions, in English and in Arabic", async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  await openBuilder(page, info.project.name);
  const base = page.url().replace("/quests", "").replace("/ar/", "/en/");
  await page.goto(base + "/sessions");
  await expect(page.getByRole("heading", { name: "Agenda", level: 1 })).toBeVisible();
  await page.getByRole("button", { name: "Add a session" }).click();
  await page.getByLabel("Title in English").fill("Opening talk");
  await page.getByLabel(/^Starts/).fill("2030-11-01T10:00");
  await page.getByLabel(/^Ends/).fill("2030-11-01T11:00");
  await page.getByLabel("Attendance").selectOption("registration");
  await page.getByLabel("Seats").fill("2");
  await page.getByRole("button", { name: "Save" }).click();
  const row = page.getByRole("listitem").filter({ hasText: "Opening talk" });
  await expect(row).toContainText("Registered: 0 of 2");

  await row.getByRole("button", { name: "Close registration" }).click();
  await expect(row).toContainText("Registration closed");
  await row.getByRole("button", { name: "Reopen registration" }).click();
  await expect(row).not.toContainText("Registration closed");

  await row.getByRole("button", { name: "Edit" }).click();
  await page.getByLabel("Starts (Asia/Riyadh)").fill("2030-11-01T20:00");
  await page.getByLabel("Ends (Asia/Riyadh)").fill("2030-11-01T21:00");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("outside the event")).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();

  await page.getByLabel("Sessions file", { exact: true }).setInputFiles({
    name: "sessions.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(IMPORT_FILE),
  });
  await expect(page.getByText("Row 3:")).toContainText("Write a title");
  await page.getByRole("button", { name: "Import 1 sessions" }).click();
  await expect(page.getByRole("status")).toContainText("1 sessions imported.");
  await expect(page.getByRole("listitem").filter({ hasText: "Imported workshop" })).toBeVisible();

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export report" }).click();
  expect((await download).suggestedFilename()).toBe("sessions.csv");

  await row.getByRole("button", { name: "Delete" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
  await expect(row).toHaveCount(0);

  await page.goto(base.replace("/en/", "/ar/") + "/sessions");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByRole("heading", { name: "الجدول", level: 1 })).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: "ورشة مستوردة" })).toBeVisible();
});
