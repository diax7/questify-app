import { expect, test, type Page } from "@playwright/test";
import { openBuilder } from "#e2e/builder.ts";
import { CONTROL_PORT } from "#e2e/paths.ts";

/**
 * Stations (T-309), in Arabic: a scan quest whose code is shown on a screen (the printed QR unticks), a station page
 * that shows only its pairing code, paired from the event's Devices page; it then shows the quest and its rotating
 * code, which a player scans through the API and is paid; revoking it from the Devices page sends the station back to
 * its pairing code. Desktop and phone.
 */

const API = "http://127.0.0.1:4100";
const PAIRING = /[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{4}/;

async function expectNoSidewaysScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

/** The quest id inside a signed screen code (its bytes 1 to 16). */
const questOf = (token: string): string => {
  const hex = Buffer.from(token, "base64url").subarray(1, 17).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

test("pairs a station from the Devices page, pays a scan of its code, and blanks it on Revoke", async ({
  page,
  browser,
}, info) => {
  test.setTimeout(120_000);
  await openBuilder(page, info.project.name);
  await page.getByRole("button", { name: "إضافة مهمة" }).click();
  await page.getByLabel("العنوان بالعربية", { exact: true }).fill("شاشة القاعة");
  const printed = page.getByLabel("يمسح اللاعب رمز المهمة");
  await expect(printed).toBeChecked();
  await page.getByLabel("رمز QR على شاشة (يتغير كل 30 ثانية)").check();
  await expect(printed).not.toBeChecked();
  await expect(page.getByText("يمكن تصوير الرمز المطبوع ومشاركته")).toBeVisible();
  await page.getByRole("button", { name: "إضافة المهمة" }).click();
  await expect(page.getByRole("listitem").filter({ hasText: "شاشة القاعة" })).toBeVisible();

  const eventUrl = page.url().replace(/\/quests$/, "");
  const eventId = eventUrl.split("/").at(-1) ?? "";
  await page.request.post(`http://127.0.0.1:${CONTROL_PORT}/event-status`, {
    data: { eventId, status: "live" },
  });

  const tv = await browser.newContext();
  const station = await tv.newPage();
  station.on("pageerror", (error) => {
    throw error;
  });
  await station.goto("/ar/station");
  await expect(station.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(station.getByText("بانتظار الربط")).toBeVisible();
  const code = (await station.getByText(PAIRING).textContent()) ?? "";
  expect(code).toMatch(PAIRING);
  await expect(station.getByText("ملتقى نجد")).toHaveCount(0);

  await page.goto(`${eventUrl}/devices`);
  await expect(page.getByRole("heading", { name: "الأجهزة", level: 1 })).toBeVisible();
  await page.getByLabel("الرمز الظاهر على الشاشة").fill(code.toLowerCase());
  await page.getByRole("button", { name: "متابعة" }).click();
  await expect(page.getByText("تقول الشاشة إنها:")).toBeVisible();
  await page
    .getByRole("combobox", { name: "مهمة", exact: true })
    .selectOption({ label: "شاشة القاعة" });
  await page.getByRole("textbox", { name: "الاسم" }).fill("شاشة القاعة ب");
  await page.getByRole("button", { name: "ربط", exact: true }).click();
  await expect(page.getByText("تم الربط. تظهر المهمة على الشاشة خلال ثوانٍ.")).toBeVisible();
  await expectNoSidewaysScroll(page);

  await expect(station.getByRole("heading", { name: "شاشة القاعة" })).toBeVisible({
    timeout: 20_000,
  });
  await expect(station.getByRole("img", { name: "امسح الرمز بتطبيق كويستفاي" })).toBeVisible();
  await expect(station.getByText("شاشة القاعة ب")).toBeVisible();
  await expectNoSidewaysScroll(station);

  const secret = (await tv.cookies()).find((cookie) => cookie.name === "__Host-qs_device");
  expect(secret?.httpOnly).toBe(true);
  const shown = await page.request.get(`${API}/v1/device/screen-code`, {
    headers: { cookie: `__Host-qs_device=${secret?.value ?? ""}` },
  });
  expect(shown.status()).toBe(200);
  const { url } = (await shown.json()) as { url: string };
  const token = url.slice(url.lastIndexOf("/") + 1);
  const player = (await (
    await page.request.post(`http://127.0.0.1:${CONTROL_PORT}/player-token`, {
      data: { eventId, usernames: [`station_${info.project.name}_${Date.now() % 1e6}`] },
    })
  ).json()) as { token: string };
  const paid = await page.request.post(`${API}/v1/quests/${questOf(token)}/complete`, {
    headers: { authorization: `Bearer ${player.token}`, "idempotency-key": crypto.randomUUID() },
    data: { proof: { type: "screen", code: token } },
  });
  expect(paid.status(), await paid.text()).toBe(200);
  expect(await paid.json()).toMatchObject({ replayed: false });

  // The list is read every 15 seconds; reading it again now shows the screen working without that wait.
  await page.reload();
  const device = page.getByRole("listitem").filter({ hasText: "شاشة القاعة ب" });
  await expect(device).toContainText("يعمل");
  await device.getByRole("button", { name: "إلغاء الربط" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "إلغاء الربط" }).click();
  await expect(device).toContainText("أُلغي ربطه");

  await expect(station.getByText("بانتظار الربط")).toBeVisible({ timeout: 20_000 });
  await expect(station.getByRole("heading", { name: "شاشة القاعة" })).toHaveCount(0);
  await tv.close();
});

test("a station's code scanned outside the app, and a pairing QR, land on pages that say to use the app", async ({
  page,
}) => {
  page.on("pageerror", (error) => {
    throw error;
  });
  const token = Buffer.concat([Buffer.from([0x07]), Buffer.alloc(36, 9)]).toString("base64url");
  await page.goto(`/s/${token}`);
  await expect(page).toHaveURL(new RegExp(`/(ar|en)/s/${token}$`));
  await page.goto(`/ar/s/${token}`);
  await expect(page.getByRole("heading", { name: "رمز شاشة كويستفاي" })).toBeVisible();
  await expect(page.getByText("امسح هذا الرمز من داخل تطبيق كويستفاي")).toBeVisible();
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
  await page.goto("/en/pair#ABCDEFGH");
  await expect(page.getByRole("heading", { name: "Pair a device" })).toBeVisible();
  await expect(page.getByText("Open Questify, then Tools → Pair a device")).toBeVisible();
});

test("a big screen shows only its pairing code until it is paired", async ({ browser }) => {
  const screen = await (await browser.newContext()).newPage();
  screen.on("pageerror", (error) => {
    throw error;
  });
  await screen.goto("/en/screen");
  await expect(screen.getByText("Big screen")).toBeVisible();
  await expect(screen.getByText("Waiting to be paired")).toBeVisible();
  await expect(screen.getByText(PAIRING)).toBeVisible();
  await screen.reload();
  await expect(screen.getByText(PAIRING)).toBeVisible();
});
