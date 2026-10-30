import { expect, test } from "@playwright/test";
import { openBuilder } from "#e2e/builder.ts";
import { CONTROL_PORT } from "#e2e/paths.ts";

/**
 * The hint on a hidden category (T-501g, FR-238), in Arabic: the button is on a hidden category only, a rehearsal with
 * no account has no one to tell, the confirmation counts the members who would be told, a press tells them (the push worker's fan-out
 * runs in the e2e server), and the next press finds no one left.
 */
test("sends a hidden category's hint after a confirmation that counts the members", async ({
  page,
  request,
}, info) => {
  test.setTimeout(90_000);
  await openBuilder(page, info.project.name);
  const eventId = /\/events\/([0-9a-f-]{36})\/quests/.exec(page.url())?.[1];
  const tag = `${info.project.name.slice(0, 2)}${Date.now() % 1_000_000}`;
  const control = `http://127.0.0.1:${CONTROL_PORT}`;

  await page.getByLabel("اسم فئة بالعربية", { exact: true }).fill("الحديقة السرية");
  await page.getByRole("button", { name: "إضافة فئة" }).click();
  const garden = page.getByRole("region", { name: "الحديقة السرية" });
  const hint = garden.getByRole("button", { name: "أرسل تلميحًا" });
  await expect(hint).toHaveCount(0);
  await garden.getByRole("button", { name: "تعديل فئة" }).click();
  await garden.getByLabel("مخفية حتى تُكتشف", { exact: true }).check();
  await garden.getByRole("button", { name: "حفظ فئة" }).click();
  await expect(garden.getByText("مخفية حتى تُكتشف")).toBeVisible();
  // The shown category beside it never gets the button.
  await expect(page.getByRole("button", { name: "أرسل تلميحًا" })).toHaveCount(1);

  // The draft event's rehearsal is open but has no account yet: there is no one to tell, and no dialog.
  await hint.click();
  await expect(page.getByRole("status").filter({ hasText: "لا أحد لإبلاغه الآن" })).toBeVisible();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);

  const seeded = await request.post(`${control}/players`, {
    data: { eventId, usernames: [`falcon_${tag}`, `oryx_${tag}`] },
  });
  expect(seeded.status()).toBe(204);
  const live = await request.post(`${control}/event-status`, { data: { eventId, status: "live" } });
  expect(live.status()).toBe(204);
  await page.reload();

  await garden.getByRole("button", { name: "أرسل تلميحًا" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog.getByRole("heading", { name: "إرسال التلميح؟" })).toBeFocused();
  await expect(dialog).toContainText("سيصل التلميح بإشعار إلى 2 ممن انضموا إلى الفعالية");
  await expect(dialog).toContainText("ومن ينضم لاحقًا لا يراه إلا بمسح الرمز السري.");
  await dialog.getByRole("button", { name: "إلغاء" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(garden.getByRole("button", { name: "أرسل تلميحًا" })).toBeFocused();

  await garden.getByRole("button", { name: "أرسل تلميحًا" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "أرسل التلميح" }).click();
  await expect(page.getByRole("status").filter({ hasText: "التلميح في الطريق." })).toBeVisible();

  // The fan-out tells both members and reveals the category to them; the next count finds no one left.
  await expect(async () => {
    await garden.getByRole("button", { name: "أرسل تلميحًا" }).click();
    await expect(page.getByRole("status").filter({ hasText: "لا أحد لإبلاغه الآن" })).toBeVisible({
      timeout: 1000,
    });
  }).toPass({ timeout: 20_000 });
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
});
