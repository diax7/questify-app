import { expect, test, type Page } from "@playwright/test";
import { openBuilder } from "#e2e/builder.ts";
import { CONTROL_PORT } from "#e2e/paths.ts";

/**
 * Cheers (T-509), in Arabic: the owner starts a cheers moment on the Big screen page, the paired screen turns to the Cheers
 * scene alone and counts the five reactions players send, and Stop gives the screen back to its scenes. The Cheers switch
 * on the same page keeps a moment from starting while it is off.
 */

const PAIRING = /[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{4}/;
const CONTROL = `http://127.0.0.1:${CONTROL_PORT}`;
const STATUS = { timeout: 20_000 } as const;

async function control(page: Page, path: string, data: object): Promise<void> {
  const answer = await page.request.post(`${CONTROL}${path}`, { data });
  expect(answer.status(), await answer.text()).toBeLessThan(300);
}

async function expectNoSidewaysScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

test("starts a cheers moment, shows the reactions on the screen, and stops", async ({
  page,
  browser,
}, info) => {
  test.setTimeout(180_000);
  await openBuilder(page, info.project.name);
  const eventUrl = page.url().replace(/\/quests$/, "");
  const eventId = eventUrl.split("/").at(-1) ?? "";
  await control(page, "/event-status", { eventId, status: "live" });
  await control(page, "/big-screen-seed", { eventId });

  const tv = await browser.newContext();
  const screen = await tv.newPage();
  screen.on("pageerror", (error) => {
    throw error;
  });
  await screen.goto("/ar/screen");
  const code = (await screen.getByText(PAIRING).textContent()) ?? "";
  await page.goto(`${eventUrl}/devices`);
  await page.getByLabel("الرمز الظاهر على الشاشة").fill(code.toLowerCase());
  await page.getByRole("button", { name: "متابعة" }).click();
  await page.getByRole("textbox", { name: "الاسم" }).fill("شاشة المسرح");
  await page.getByRole("button", { name: "ربط", exact: true }).click();
  await expect(page.getByText("تم الربط. يظهر المحتوى على الشاشة خلال ثوانٍ.")).toBeVisible();
  await expect(screen.getByText("أفضل 10")).toBeVisible(STATUS);

  // The Cheers switch is on from the start; switched off, a moment cannot start.
  await page.goto(`${eventUrl}/big-screen`);
  const start = page.getByRole("button", { name: "ابدأ لحظة تشجيع" });
  const toggle = page.getByLabel("إظهار زر التشجيع في التطبيق أثناء لحظة التشجيع");
  await expect(start).toBeEnabled();
  await expectNoSidewaysScroll(page);
  await toggle.uncheck();
  await expect(start).toBeDisabled();
  await toggle.check();
  await expect(start).toBeEnabled();
  await page.reload();
  await expect(toggle).toBeChecked();

  await page.getByLabel("المدة").selectOption("2");
  await page.getByRole("button", { name: "ابدأ لحظة تشجيع" }).click();
  await expect(page.getByText("بدأت لحظة التشجيع.")).toBeVisible();
  await expect(page.getByText(/^مباشرة حتى /)).toBeVisible();

  // The screen leaves its scenes for the Cheers scene alone and counts what players send.
  await expect(screen.getByText("شجّع من تطبيق كويستفاي!")).toBeVisible(STATUS);
  await expect(screen.getByText("أفضل 10")).toHaveCount(0);
  await control(page, "/cheered", { eventId, reactions: ["heart", "heart", "fire"] });
  const hearts = screen
    .getByRole("listitem")
    .filter({ has: screen.getByRole("img", { name: "قلب" }) });
  await expect(hearts).toContainText("2", STATUS);
  await expect(
    screen.getByRole("listitem").filter({ has: screen.getByRole("img", { name: "نار" }) }),
  ).toContainText("1");
  await expect(screen.getByRole("timer")).toContainText(/\d:\d{2}/);
  await expectNoSidewaysScroll(screen);

  // Stop gives the screen back to its scenes.
  await page.getByRole("button", { name: "أوقف اللحظة" }).click();
  await expect(page.getByText("انتهت لحظة التشجيع.")).toBeVisible();
  await expect(screen.getByText("أفضل 10")).toBeVisible(STATUS);
  await expect(screen.getByText("شجّع من تطبيق كويستفاي!")).toHaveCount(0);
  await tv.close();
});
