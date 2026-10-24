import { expect, test, type Page } from "@playwright/test";
import { openBuilder } from "#e2e/builder.ts";
import { CONTROL_PORT } from "#e2e/paths.ts";

/**
 * Location in the dashboard (T-303b): the event's venue pin and radius, a scan quest's place, and the two location
 * cases on the Flags page. All in Arabic, right to left, on the desktop and the phone screen.
 */

const LAT = "خط العرض";
const LNG = "خط الطول";
const PLACE_RADIUS = "نصف القطر (بالأمتار، 20 إلى 2000)";
const VENUE_RADIUS = "نصف قطر المكان (بالأمتار، 100 إلى 20000)";
const SAVE_EVENT = "حفظ التغييرات";

async function expectNoSidewaysScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

test("an owner saves the event's venue pin and radius, sees them again, and clears the pin", async ({
  page,
}, info) => {
  test.setTimeout(90_000);
  await openBuilder(page, info.project.name);
  await page.goto(page.url().replace(/\/quests$/, ""));
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");

  const pin = page.getByRole("group", { name: "موقع مكان الفعالية (اختياري)" });
  await expect(pin).toContainText("يُستخدم فقط لرصد عمليات المسح البعيدة");
  await expect(pin.getByLabel(VENUE_RADIUS)).toHaveValue("1000");
  await pin.getByLabel(LAT, { exact: true }).fill("24.7136");
  await pin.getByLabel(LNG, { exact: true }).fill("46.6753");
  await pin.getByLabel(VENUE_RADIUS).fill("800");
  await page.getByRole("button", { name: SAVE_EVENT }).click();
  await expect(page.getByText("حُفظت التغييرات.")).toBeVisible();

  await page.reload();
  await expect(pin.getByLabel(LAT, { exact: true })).toHaveValue("24.7136");
  await expect(pin.getByLabel(LNG, { exact: true })).toHaveValue("46.6753");
  await expect(pin.getByLabel(VENUE_RADIUS)).toHaveValue("800");

  // Half a pin is named before anything is sent.
  await pin.getByLabel(LNG, { exact: true }).fill("");
  await page.getByRole("button", { name: SAVE_EVENT }).click();
  await expect(page.locator("p[role=alert]")).toContainText("أدخل خط عرض بين -90 و90");

  await pin.getByLabel(LAT, { exact: true }).fill("");
  await page.getByRole("button", { name: SAVE_EVENT }).click();
  await expect(page.getByText("حُفظت التغييرات.")).toBeVisible();
  await page.reload();
  await expect(pin.getByLabel(LAT, { exact: true })).toHaveValue("");
  await expectNoSidewaysScroll(page);
});

test("a scan quest takes an optional place and keeps it; the location type waits for the platform switch", async ({
  page,
}, info) => {
  test.setTimeout(90_000);
  await openBuilder(page, info.project.name);
  await page.getByRole("button", { name: "إضافة مهمة" }).click();

  // The platform's location switch is off by default: the type is not offered.
  const types = page.getByRole("combobox", { name: /^نوع مهمة/ });
  await expect(types.locator("option[value=location]")).toHaveCount(0);

  const place = page.getByRole("group", { name: "المكان" });
  await expect(place).toContainText("اختياري: نقطة المكان ونصف قطره");
  await page.getByLabel("العنوان بالعربية", { exact: true }).fill("بوابة الدخول");
  await place.getByLabel(LAT, { exact: true }).fill("24.7136");
  await page.getByRole("button", { name: "إنشاء مهمة" }).click();
  await expect(page.locator("p[role=alert]")).toContainText("أدخل خط عرض بين -90 و90");

  await place.getByLabel(LNG, { exact: true }).fill("46.6753");
  await place.getByLabel(PLACE_RADIUS).fill("150");
  await page.getByRole("button", { name: "إنشاء مهمة" }).click();
  const row = page.getByRole("listitem").filter({ hasText: "بوابة الدخول" });
  await expect(row).toBeVisible();

  await row.getByRole("button", { name: "تعديل", exact: true }).click();
  const saved = page.getByRole("group", { name: "المكان" });
  await expect(saved.getByLabel(LAT, { exact: true })).toHaveValue("24.7136");
  await expect(saved.getByLabel(LNG, { exact: true })).toHaveValue("46.6753");
  await expect(saved.getByLabel(PLACE_RADIUS)).toHaveValue("150");
  await expectNoSidewaysScroll(page);

  // Clearing both numbers removes the place.
  await saved.getByLabel(LAT, { exact: true }).fill("");
  await saved.getByLabel(LNG, { exact: true }).fill("");
  await page.getByRole("button", { name: "حفظ مهمة" }).click();
  await expect(page.getByRole("heading", { name: "تعديل مهمة" })).toHaveCount(0);
  await row.getByRole("button", { name: "تعديل", exact: true }).click();
  await expect(
    page.getByRole("group", { name: "المكان" }).getByLabel(LAT, { exact: true }),
  ).toHaveValue("");
});

test("the Flags page words a far-from-venue case and an impossible-speed case", async ({
  page,
  request,
}, info) => {
  test.setTimeout(90_000);
  await openBuilder(page, info.project.name);
  const eventId = /\/events\/([0-9a-f-]{36})\/quests/.exec(page.url())?.[1];
  const tag = `${info.project.name.slice(0, 2)}${Date.now() % 1_000_000}`;
  const seeded = await request.post(`http://127.0.0.1:${CONTROL_PORT}/location-flagged`, {
    data: { eventId, usernames: [`far_${tag}`, `fast_${tag}`] },
  });
  expect(seeded.status()).toBe(204);

  await page.goto(page.url().replace(/\/quests$/, "/flags"));
  await expect(page.getByRole("heading", { name: "نشاط مريب", level: 2 })).toBeVisible();

  const far = page
    .getByRole("listitem")
    .filter({ hasText: `@far_${tag}` })
    .first();
  await expect(far).toContainText("بعيد عن مكان الفعالية (1)");
  await far.getByRole("button", { name: "عرض الحالة" }).click();
  await expect(far.getByText("على بُعد 2.4 كم من مكان الفعالية (±30 م)")).toBeVisible();
  await expect(far.getByText("أبلغ الجوال عن موقع مزيّف")).toBeVisible();

  const fast = page
    .getByRole("listitem")
    .filter({ hasText: `@fast_${tag}` })
    .first();
  await expect(fast).toContainText("تنقّل أسرع من الممكن (2)");
  await fast.getByRole("button", { name: "عرض الحالة" }).click();
  await expect(fast.getByText("910 م خلال 40 ث من المكان السابق")).toBeVisible();
  await expect(fast.getByText("البوابة أ")).toBeVisible();
  await expectNoSidewaysScroll(page);
});
