import { expect, test } from "@playwright/test";
import { openBuilder } from "#e2e/builder.ts";
import { openMenu } from "#e2e/nav.ts";
import { CONTROL_PORT } from "#e2e/paths.ts";

/**
 * The live control room (T-603), in Arabic: the counters and the feed of completions with only a username, each quest's
 * completions and rate, the Up next pin, a flash quest launched, a boost started and an announcement composed and
 * confirmed, all on one page reached from the menu; the English heading and the switch that takes an action away.
 */
test("runs an event from the control room", async ({ page, request }, info) => {
  test.setTimeout(120_000);
  await openBuilder(page, info.project.name);
  const builder = page.url();
  const eventId = /\/events\/([0-9a-f-]{36})\/quests/.exec(builder)?.[1];
  const tag = `${info.project.name.slice(0, 2)}${Date.now() % 1_000_000}`;

  await page.getByRole("button", { name: "إضافة مهمة" }).click();
  await page.getByLabel("العنوان بالعربية", { exact: true }).fill("الصقر الذهبي");
  await page.getByLabel("مهمة بوقت محدود", { exact: true }).check();
  await page.getByRole("button", { name: "إنشاء مهمة" }).click();
  await expect(page.getByText("خاطفة، لم تنطلق")).toBeVisible();

  const control = `http://127.0.0.1:${CONTROL_PORT}`;
  const seeded = await request.post(`${control}/flagged`, {
    data: { eventId, usernames: [`falcon_${tag}`] },
  });
  expect(seeded.status()).toBe(204);
  const live = await request.post(`${control}/event-status`, { data: { eventId, status: "live" } });
  expect(live.status()).toBe(204);

  await page.goto(builder.replace(/\/quests$/, ""));
  await openMenu(page);
  await page.getByRole("link", { name: "غرفة التحكم" }).click();
  await expect(page.getByRole("heading", { name: "غرفة التحكم", level: 1 })).toBeVisible();

  const counters = page.getByRole("region", { name: "أرقام مباشرة" });
  await expect(counters.getByRole("listitem").filter({ hasText: "نشاط مريب" })).toContainText("1");
  await expect(
    counters.getByRole("listitem").filter({ hasText: "نشطون في آخر 15 دقيقة" }),
  ).toContainText("1");
  await expect(
    counters.getByRole("listitem").filter({ hasText: "جوائز توشك على النفاد" }),
  ).toContainText("0");

  const feed = page.getByRole("region", { name: "آخر النشاط" });
  await expect(feed.getByRole("listitem")).toHaveCount(10);
  await expect(feed.getByRole("listitem").first()).toContainText(`falcon_${tag}`);
  await expect(feed.getByRole("listitem").first()).toContainText("رمز QR");
  await expect(feed).not.toContainText("@riyadh.test");

  const quests = page.getByRole("region", { name: "مهام", exact: true });
  const lion = quests.getByRole("listitem").filter({ hasText: "الأسد 3" });
  await expect(lion).toContainText("المنجزون: 1 (100%)");
  await lion.getByRole("button", { name: "تثبيت في «التالي»" }).click();
  await expect(lion.getByText("مثبّت في «التالي»")).toBeVisible();

  const flash = quests.getByRole("listitem").filter({ hasText: "الصقر الذهبي" });
  await expect(flash).toContainText("المنجزون: 0 (0%)");
  const boosts = page.getByRole("region", { name: "النقاط المضاعفة" });
  await boosts.getByRole("button", { name: "مضاعفة جديدة" }).click();
  await boosts.getByRole("button", { name: "حفظ" }).click();
  await expect(boosts.getByText("حُفظت المضاعفة.")).toBeVisible();
  await expect(boosts.getByText("جارية")).toBeVisible();

  // An emulated phone pans its visual viewport when a field takes focus and keeps the pan, which shifts later clicks; so each part that types starts on a fresh page.
  await page.reload();
  await expect(page.getByRole("heading", { name: "غرفة التحكم", level: 1 })).toBeVisible();
  await page.getByLabel("العنوان بالعربية", { exact: true }).fill("افتتاح القاعة");
  await page.getByLabel("العنوان بالإنجليزية", { exact: true }).fill("Hall open");
  await page.getByLabel("النص بالعربية", { exact: true }).fill("القاعة مفتوحة الآن");
  await page.getByLabel("النص بالإنجليزية", { exact: true }).fill("The hall is open now");
  await page.getByRole("button", { name: "إرسال الإعلان" }).click();
  const confirm = page.getByRole("alertdialog");
  await expect(confirm).toContainText("سيصل الآن إلى 1 ممن انضموا إلى الفعالية.");
  await confirm.getByRole("button", { name: "إلغاء" }).click();
  await expect(confirm).toHaveCount(0);

  await page.reload();
  await expect(page.getByRole("heading", { name: "غرفة التحكم", level: 1 })).toBeVisible();
  const running = page
    .getByRole("region", { name: "مهام", exact: true })
    .getByRole("listitem")
    .filter({ hasText: "الصقر الذهبي" });
  await running.getByRole("button", { name: "أطلق الآن" }).click();
  const launch = page.getByRole("alertdialog");
  await launch.getByLabel("المدة بالدقائق (1 إلى 1440)").fill("20");
  await launch.getByRole("button", { name: "أطلق الآن" }).click();
  await expect(running.getByText(/^خاطفة، تنتهي /)).toBeVisible();

  await page.goto(page.url().replace("/ar/", "/en/"));
  await expect(page.getByRole("heading", { name: "Control room", level: 1 })).toBeVisible();
  await expect(page.getByRole("region", { name: "Latest activity" })).toBeVisible();
});

test("offers no boost or flash launch while their switches are off", async ({ page }, info) => {
  test.setTimeout(90_000);
  await openBuilder(page, info.project.name);
  const event = page.url().replace(/\/quests$/, "");
  await page.getByRole("button", { name: "إضافة مهمة" }).click();
  await page.getByLabel("العنوان بالعربية", { exact: true }).fill("الصقر الذهبي");
  await page.getByLabel("مهمة بوقت محدود", { exact: true }).check();
  await page.getByRole("button", { name: "إنشاء مهمة" }).click();
  await expect(page.getByText("خاطفة، لم تنطلق")).toBeVisible();

  await page.goto(event);
  for (const label of ["تشغيل مهام بوقت محدود في الفعالية", "تشغيل النقاط المضاعفة في الفعالية"]) {
    const toggle = page.getByLabel(label);
    await toggle.uncheck();
    // The box is disabled while the change is being saved.
    await expect(toggle).toBeEnabled();
    await expect(toggle).not.toBeChecked();
  }
  await page.goto(`${event}/control`);
  await expect(page.getByRole("heading", { name: "غرفة التحكم", level: 1 })).toBeVisible();
  const flash = page
    .getByRole("region", { name: "مهام", exact: true })
    .getByRole("listitem")
    .filter({ hasText: "الصقر الذهبي" });
  await expect(flash).toBeVisible();
  await expect(flash.getByRole("button", { name: "أطلق الآن" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "النقاط المضاعفة" })).toHaveCount(0);
});
