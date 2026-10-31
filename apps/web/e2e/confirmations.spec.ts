import { expect, test } from "@playwright/test";
import { openBuilder } from "#e2e/builder.ts";
import { CONTROL_PORT } from "#e2e/paths.ts";

/**
 * The confirmation sweep (T-604b, FR-1031, FR-1032), in Arabic: in a live event, turning a switch off and moving the
 * event's times each say what happens first, Cancel changes nothing, and the action does it. (Sign out, the team, the
 * pins, the survey link and the finale are asked in the specs of their own pages.)
 */
test("asks before a live event loses a switch or moves its times", async ({ page }, info) => {
  test.setTimeout(120_000);
  await openBuilder(page, info.project.name);
  const event = page.url().replace(/\/quests$/, "");
  const eventId = /\/events\/([0-9a-f-]{36})/.exec(event)?.[1];
  const live = await page.request.post(`http://127.0.0.1:${CONTROL_PORT}/event-status`, {
    data: { eventId, status: "live" },
  });
  expect(live.status()).toBe(204);

  await page.goto(event);
  const toggle = page.getByLabel("تشغيل مهام بوقت محدود في الفعالية");
  await expect(toggle).toBeChecked();
  // The box does not change until the person confirms, so a plain click: `uncheck()` would wait for it to change.
  await toggle.click();
  const asking = page.getByRole("alertdialog");
  await expect(asking).toContainText("يفقد اللاعبون هذه الميزة الآن.");
  await asking.getByRole("button", { name: "إلغاء" }).click();
  await expect(asking).toHaveCount(0);
  await expect(toggle).toBeChecked();
  await toggle.click();
  await page.getByRole("alertdialog").getByRole("button", { name: "إيقاف" }).click();
  await expect(toggle).not.toBeChecked();
  await expect(toggle).toBeEnabled();
  await toggle.check();
  await expect(toggle).toBeChecked();

  const ends = page.getByLabel("تنتهي", { exact: true });
  const before = await ends.inputValue();
  await ends.fill("2031-01-01T10:00");
  await page.getByRole("button", { name: "حفظ التغييرات" }).click();
  const moving = page.getByRole("alertdialog");
  await expect(moving).toContainText("تتغير الأوقات التي يراها اللاعبون الآن.");
  await moving.getByRole("button", { name: "إلغاء" }).click();
  await page.reload();
  await expect(page.getByLabel("تنتهي", { exact: true })).toHaveValue(before);
  await page.getByLabel("تنتهي", { exact: true }).fill("2031-01-01T10:00");
  await page.getByRole("button", { name: "حفظ التغييرات" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "حفظ المواعيد" }).click();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await page.reload();
  await expect(page.getByLabel("تنتهي", { exact: true })).toHaveValue("2031-01-01T10:00");
});
