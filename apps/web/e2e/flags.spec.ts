import { expect, test } from "@playwright/test";
import { openBuilder } from "#e2e/builder.ts";
import { CONTROL_PORT } from "#e2e/paths.ts";

/**
 * The flagged-activity page (T-209): a burst case with its evidence, the desk's hold switch, the link from the Players
 * page, the owner's pause there, and clearing the case, in Arabic; the page's heading in English.
 */
test("the owner reviews a flagged player, pauses redemption and clears the case", async ({
  page,
  request,
}, info) => {
  test.setTimeout(90_000);
  await openBuilder(page, info.project.name);
  const eventId = /\/events\/([0-9a-f-]{36})\/quests/.exec(page.url())?.[1];
  const tag = `${info.project.name.slice(0, 2)}${Date.now() % 1_000_000}`;
  const control = `http://127.0.0.1:${CONTROL_PORT}`;
  const live = await request.post(`${control}/event-status`, { data: { eventId, status: "live" } });
  expect(live.status()).toBe(204);
  const seeded = await request.post(`${control}/flagged`, {
    data: { eventId, usernames: [`lynx_${tag}`] },
  });
  expect(seeded.status()).toBe(204);

  await page.goto(page.url().replace(/\/quests$/, "/players"));
  const lynx = page.getByRole("listitem").filter({ hasText: `@lynx_${tag}` });
  await lynx.getByRole("button", { name: "إيقاف الاستبدال" }).click();
  const pause = page.getByRole("alertdialog");
  await expect(pause.getByRole("heading")).toHaveText(`إيقاف الاستبدال لـ lynx_${tag}؟`);
  await pause.getByRole("button", { name: "إيقاف الاستبدال" }).click();
  await expect(page.getByRole("status")).toHaveText(`أُوقف الاستبدال لـ lynx_${tag}.`);
  await expect(lynx).toContainText("الاستبدال موقوف");
  await lynx.getByRole("link", { name: "حالة مفتوحة" }).click();

  await expect(page.getByRole("heading", { name: "نشاط مريب", level: 2 })).toBeVisible();
  await expect(page.getByText("مفعّل: لا يستلم صاحب حالة مفتوحة جوائزه حتى تُغلق.")).toBeVisible();
  const flagged = page
    .getByRole("listitem")
    .filter({ hasText: `@lynx_${tag}` })
    .first();
  await expect(flagged).toContainText("10 مسحًا خلال 5 دقائق");
  // Opened from the Players page's link: the evidence shows at once.
  await expect(flagged.getByText("الأسد 1", { exact: false }).first()).toBeVisible();
  await expect(flagged.getByText("الاستبدال موقوف لهذا اللاعب.")).toBeVisible();

  await page.getByRole("button", { name: "إيقاف التعليق" }).click();
  await expect(page.getByText("متوقف: تُسلَّم الجوائز رغم الحالات المفتوحة.")).toBeVisible();

  await flagged.getByRole("button", { name: "إغلاق دون إجراء" }).click();
  const clear = page.getByRole("alertdialog");
  await expect(clear.getByRole("heading")).toBeFocused();
  await clear.getByLabel("ملاحظة (اختيارية)").fill("يركض بسرعة");
  await clear.getByRole("button", { name: "إغلاق دون إجراء" }).click();
  await expect(page.getByRole("status")).toHaveText("أُغلقت الحالة.");
  await expect(page.getByText("لا حالات. يظهر هنا أي نشاط غير معتاد.")).toBeVisible();
  await page.getByRole("button", { name: "مغلقة" }).click();
  await expect(page.getByRole("listitem").filter({ hasText: `@lynx_${tag}` })).toContainText(
    "أُغلقت دون إجراء",
  );

  await page.goto(page.url().replace("/ar/", "/en/"));
  await expect(page.getByRole("heading", { name: "Flagged activity", level: 2 })).toBeVisible();
});
