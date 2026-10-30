import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, expect, test, type Page } from "@playwright/test";
import { encode } from "uqr";
import { openBuilder } from "#e2e/builder.ts";
import { CONTROL_PORT } from "#e2e/paths.ts";

/**
 * Kiosks (T-309b), in Arabic: a scan quest with the kiosk method, the kiosk page opened from the Devices page by a plain
 * link (a full page load, so it runs under its own camera and wasm headers, CTO note 4), paired there, then a tablet
 * whose fake camera shows a player's live code pays that player and shows the green card with their @username; Revoke
 * sends the kiosk back to its pairing code. The decoder's wasm is served as application/wasm, and every other page
 * keeps the camera off.
 */

const API = "http://127.0.0.1:4100";
const PAIRING = /[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{4}/;
const TABLET = { width: 1024, height: 768 };

async function expectNoSidewaysScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

/**
 * A one-frame YUV4MPEG2 video of `text` as a QR, for Chromium's fake camera (`--use-file-for-fake-video-capture`, which
 * loops it): black modules on white, centred, 10 pixels a module.
 */
function qrVideo(text: string): Buffer {
  const width = 640;
  const height = 480;
  const { data, size } = encode(text, { ecc: "M", border: 4 });
  const scale = 10;
  const left = Math.floor((width - size * scale) / 2);
  const top = Math.floor((height - size * scale) / 2);
  const luma = Buffer.alloc(width * height, 235);
  data.forEach((row, y) => {
    row.forEach((dark, x) => {
      if (!dark) {
        return;
      }
      for (let dy = 0; dy < scale; dy += 1) {
        const at = (top + y * scale + dy) * width + left + x * scale;
        luma.fill(16, at, at + scale);
      }
    });
  });
  const chroma = Buffer.alloc((width / 2) * (height / 2) * 2, 128);
  return Buffer.concat([
    Buffer.from(`YUV4MPEG2 W${width} H${height} F30:1 Ip A1:1 C420jpeg\nFRAME\n`),
    luma,
    chroma,
  ]);
}

/** A player of the event and a live code of theirs fetched early in its window, so it is still good when shown. */
async function freshLiveCode(page: Page, eventId: string, username: string) {
  const player = (await (
    await page.request.post(`http://127.0.0.1:${CONTROL_PORT}/player-token`, {
      data: { eventId, usernames: [username] },
    })
  ).json()) as { token: string };
  const fetchCode = async () => {
    const answer = await page.request.get(`${API}/v1/me/live-code`, {
      headers: { authorization: `Bearer ${player.token}` },
    });
    expect(answer.status(), await answer.text()).toBe(200);
    return (await answer.json()) as { code: string; changesInMs: number };
  };
  const first = await fetchCode();
  if (first.changesInMs >= 20_000) {
    return first.code;
  }
  await page.waitForTimeout(first.changesInMs + 500);
  return (await fetchCode()).code;
}

test("pairs a kiosk opened from the Devices page; its camera reads a live code and pays; Revoke blanks it", async ({
  page,
}, info) => {
  test.skip(
    info.project.name !== "desktop",
    "the tablet's fake camera runs once, in its own browser",
  );
  test.setTimeout(180_000);
  await openBuilder(page, info.project.name);
  await page.getByRole("button", { name: "إضافة مهمة" }).click();
  await page.getByLabel("العنوان بالعربية", { exact: true }).fill("كشك البوابة");
  await page.getByLabel("كشك ذاتي (يعرض اللاعب رمزه المباشر أمام جهاز لوحي)").check();
  await expect(page.getByText("يدفع الكشك النقاط دون أن يقف عنده أحد.")).toBeAttached();
  await page.getByRole("button", { name: "إنشاء مهمة" }).click();
  await expect(page.getByRole("listitem").filter({ hasText: "كشك البوابة" })).toBeVisible();

  const eventUrl = page.url().replace(/\/quests$/, "");
  const eventId = eventUrl.split("/").at(-1) ?? "";
  await page.request.post(`http://127.0.0.1:${CONTROL_PORT}/event-status`, {
    data: { eventId, status: "live" },
  });

  // The kiosk page, opened by clicking its link on the Devices page: a full load under the kiosk's own headers.
  const opener = await page.context().newPage();
  await opener.goto(`${eventUrl}/devices`);
  const loaded = opener.waitForResponse((response) => response.url().endsWith("/ar/kiosk"));
  await opener.getByRole("link", { name: "/ar/kiosk" }).click();
  const headers = (await loaded).headers();
  expect(headers["permissions-policy"]).toContain("camera=(self)");
  expect(headers["content-security-policy"]).toContain("'wasm-unsafe-eval'");
  await expect(opener).toHaveURL(/\/ar\/kiosk$/);
  await expect(opener.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(opener.getByText("بانتظار الربط")).toBeVisible();
  const code = (await opener.getByText(PAIRING).textContent()) ?? "";

  await page.goto(`${eventUrl}/devices`);
  await page.getByLabel("الرمز الظاهر على الشاشة").fill(code);
  await page.getByRole("button", { name: "متابعة" }).click();
  await page
    .getByRole("combobox", { name: "مهمة", exact: true })
    .selectOption({ label: "كشك البوابة" });
  await page.getByRole("textbox", { name: "الاسم" }).fill("كشك البوابة أ");
  await page.getByRole("button", { name: "ربط", exact: true }).click();
  await expect(page.getByText("ثبّت الجهاز اللوحي على هذه الصفحة")).toBeVisible();
  await expect(opener.getByRole("button", { name: "السماح بالكاميرا" })).toBeVisible({
    timeout: 20_000,
  });
  await expect(opener.getByRole("heading", { name: "كشك البوابة" })).toBeVisible();
  const device = (await page.context().cookies()).find(
    (cookie) => cookie.name === "__Host-qs_device",
  );
  expect(device?.httpOnly).toBe(true);
  await opener.close();

  // The tablet: its own browser, whose fake front camera shows a player's live code.
  const username = `kiosk_${Date.now() % 1e6}`;
  const folder = await mkdtemp(join(tmpdir(), "kiosk-"));
  const video = join(folder, "live-code.y4m");
  await writeFile(video, qrVideo(await freshLiveCode(page, eventId, username)));
  const tabletBrowser = await chromium.launch({
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      `--use-file-for-fake-video-capture=${video}`,
    ],
  });
  try {
    const tablet = await tabletBrowser.newContext({
      baseURL: new URL(page.url()).origin,
      viewport: TABLET,
      permissions: ["camera"],
    });
    if (device !== undefined) {
      await tablet.addCookies([device]);
    }
    const kiosk = await tablet.newPage();
    kiosk.on("pageerror", (error) => {
      throw error;
    });
    await kiosk.goto("/ar/kiosk");
    await kiosk.getByRole("button", { name: "السماح بالكاميرا" }).click();
    const card = kiosk.getByRole("status").filter({ hasText: `@${username}` });
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card).toContainText("+10 نقطة");
    await expectNoSidewaysScroll(kiosk);

    const line = page.getByRole("listitem").filter({ hasText: "كشك البوابة أ" });
    await page.reload();
    await expect(line).toContainText("المسحات اليوم: 1");
    await line.getByRole("button", { name: "إلغاء الربط" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "إلغاء الربط" }).click();
    await expect(line).toContainText("أُلغي ربطه");
    await expect(kiosk.getByText("بانتظار الربط")).toBeVisible({ timeout: 20_000 });
    await expect(kiosk.getByRole("button", { name: "السماح بالكاميرا" })).toHaveCount(0);
  } finally {
    await tabletBrowser.close();
  }
});

test("serves the decoder's wasm as application/wasm; only the kiosk pages may use the camera", async ({
  page,
}) => {
  const wasm = await page.request.get("/zxing/zxing_reader-3.1.5.wasm");
  expect(wasm.status()).toBe(200);
  expect(wasm.headers()["content-type"]).toContain("application/wasm");
  for (const path of ["/en/station", "/ar/screen", "/en/sign-in"]) {
    const answer = await page.request.get(path);
    expect(answer.headers()["permissions-policy"], path).toContain("camera=()");
    expect(answer.headers()["content-security-policy"], path).not.toContain("wasm-unsafe-eval");
  }
  const kiosk = await page.request.get("/en/kiosk");
  expect(kiosk.headers()["permissions-policy"]).toContain("camera=(self)");
});
