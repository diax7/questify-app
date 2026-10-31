import { expect, test, type Page } from "@playwright/test";
import { openBuilder } from "#e2e/builder.ts";
import { CONTROL_PORT } from "#e2e/paths.ts";

/**
 * The live finale (T-307b), in Arabic: the owner sets the finale and its last push on the Big screen page, the paired
 * screen counts down on the server's clock, turns to the push when the time comes (the goal's bar, then "not reached"),
 * stays open after the event ends, and shows the winners with a username and an avatar and no score only once the owner
 * confirmed and revealed them on the Prizes and results page.
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

/** The Riyadh wall-clock time `minutes` from now, as a `datetime-local` field takes it. */
const riyadhIn = (minutes: number): string =>
  new Date(Date.now() + minutes * 60_000)
    .toLocaleString("sv-SE", { timeZone: "Asia/Riyadh" })
    .replace(" ", "T")
    .slice(0, 16);

test("sets a finale, counts down, pushes, and shows the winners only after the owner reveals them", async ({
  page,
  browser,
}, info) => {
  test.setTimeout(240_000);
  await openBuilder(page, info.project.name);
  const eventUrl = page.url().replace(/\/quests$/, "");
  const eventId = eventUrl.split("/").at(-1) ?? "";
  await control(page, "/event-status", { eventId, status: "live" });
  await control(page, "/big-screen-seed", { eventId });
  const suffix = `${info.project.name}${Date.now() % 1e6}`;
  await control(page, "/scored", {
    eventId,
    usernames: [`sara_${suffix}`, `khalid_${suffix}`],
    points: [150, 90],
  });

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
  await expect(screen.getByText("أفضل 10")).toBeVisible({ timeout: 20_000 });

  // The owner picks no other scene, sets the finale 40 minutes ahead with the community goal as its last push.
  await page.goto(`${eventUrl}/big-screen`);
  for (const scene of ["الترتيب المباشر (أفضل 10)", "الهدف الجماعي", "الاستطلاع المباشر"]) {
    await page.getByRole("checkbox", { name: scene }).uncheck();
  }
  await page.getByRole("button", { name: "حفظ المشاهد" }).click();
  await expect(page.getByText("حُفظت المشاهد. تتحدّث الشاشات خلال ثوانٍ.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "الختام المباشر" })).toBeVisible();
  await expectNoSidewaysScroll(page);
  await page.getByLabel("وقت الختام").fill(riyadhIn(40));
  await page.getByLabel("الدفعة الأخيرة (هدف جماعي)").selectOption({ index: 1 });
  await page.getByRole("button", { name: "حفظ الختام" }).click();
  await expect(page.getByText("حُفظ الختام. تتحدّث الشاشات خلال ثوانٍ.")).toBeVisible();
  await expect(page.getByText("تنتهي الفعالية في")).toBeVisible();

  // The screen counts down in three groups of Western digits, and shows no winner and no goal yet.
  await expect(screen.getByText("يبدأ الختام بعد")).toBeVisible(STATUS);
  await expect(screen.getByRole("timer").locator("span").nth(1)).toHaveText(/^\d{2}$/);
  await expect(screen.getByText("أضيئوا البرج")).toHaveCount(0);
  await expect(screen.getByText("الفائزون")).toHaveCount(0);
  await expectNoSidewaysScroll(screen);

  // Once the time has come the page cannot change the finale any more; the screen turns to the last push.
  await control(page, "/finale-step", { eventId, step: "start" });
  await expect(screen.getByText("الدفعة الأخيرة")).toBeVisible(STATUS);
  await expect(screen.getByText("أضيئوا البرج")).toBeVisible();
  await expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "40");
  await page.reload();
  await expect(page.getByText("بدأ الختام ولا يمكن تغيير وقته أو هدفه")).toBeVisible();
  await expect(page.getByRole("button", { name: "حفظ الختام" })).toBeDisabled();

  // The goal is missed: the screen says so; the event ends and the screen stays open for the finale.
  await control(page, "/finale-step", { eventId, step: "finish-goal" });
  await expect(screen.getByText("لم يتحقق الهدف هذه المرة")).toBeVisible(STATUS);
  await control(page, "/event-status", { eventId, status: "ended", endedDaysAgo: 0 });
  await expect(screen.getByText("يُعلن الفائزون بعد قليل")).toBeVisible(STATUS);
  await expect(screen.getByText(`sara_${suffix}`)).toHaveCount(0);

  // The owner confirms and reveals on the Prizes and results page; only then do the winners reach the screen.
  await page.goto(`${eventUrl}/prizes`);
  await page.getByRole("button", { name: "تأكيد النتائج" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "تأكيد النتائج" }).click();
  await expect(page.getByRole("status")).toHaveText("أُكّدت النتائج.");
  await expect(screen.getByText(`sara_${suffix}`)).toHaveCount(0);
  await page.getByRole("button", { name: "إعلان الفائزين" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "إعلان الفائزين" }).click();
  await expect(page.getByRole("status")).toHaveText("أُعلن الفائزون.");

  await expect(screen.getByText(`sara_${suffix}`)).toBeVisible(STATUS);
  const rows = screen.getByRole("listitem");
  await expect(rows.nth(0)).toContainText(`sara_${suffix}`);
  await expect(rows.nth(1)).toContainText(`khalid_${suffix}`);
  await expect(screen.getByText("150")).toHaveCount(0);
  await expect(screen.getByText("الفائزون")).toBeVisible();
  await expectNoSidewaysScroll(screen);

  // The dashboard says the winners are on the screen, and the finale can still be cleared.
  await page.goto(`${eventUrl}/big-screen`);
  await expect(page.getByText("أُعلن الفائزون، وأسماؤهم على الشاشة الآن.")).toBeVisible();
  await page.getByRole("button", { name: "إلغاء الختام" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "إلغاء الختام" }).click();
  await expect(page.getByText("أُلغي الختام.")).toBeVisible();
  await tv.close();
});

test("an English finale reads left to right and a refused time is explained", async ({
  page,
  browser,
}, info) => {
  test.setTimeout(150_000);
  await openBuilder(page, info.project.name);
  const eventUrl = page.url().replace(/\/quests$/, "");
  const eventId = eventUrl.split("/").at(-1) ?? "";
  await control(page, "/event-status", { eventId, status: "live" });
  await control(page, "/big-screen-seed", { eventId });

  await page.goto(`${eventUrl.replace("/ar/", "/en/")}/big-screen`);
  await expect(page.getByRole("heading", { name: "Live finale" })).toBeVisible();
  await page.getByLabel("Finale time").fill(riyadhIn(-30));
  await page.getByRole("button", { name: "Save the finale" }).click();
  await expect(
    page.getByText(
      "Pick a time in the future, after the event starts and within 23 hours after it ends.",
    ),
  ).toBeVisible();

  await page.getByLabel("Finale time").fill(riyadhIn(30));
  await page.getByRole("button", { name: "Save the finale" }).click();
  await expect(page.getByText("Finale saved. Screens update within a few seconds.")).toBeVisible();
  for (const scene of ["Live ranking (top 10)", "Community goal", "Live poll"]) {
    await page.getByRole("checkbox", { name: scene }).uncheck();
  }
  await page.getByRole("button", { name: "Save scenes" }).click();
  await expect(page.getByText("Scenes saved. Screens update within a few seconds.")).toBeVisible();

  const tv = await browser.newContext();
  const screen = await tv.newPage();
  await screen.goto("/en/screen");
  const code = (await screen.getByText(PAIRING).textContent()) ?? "";
  await page.goto(`${eventUrl}/devices`);
  await page.getByLabel("الرمز الظاهر على الشاشة").fill(code);
  await page.getByRole("button", { name: "متابعة" }).click();
  await page.getByRole("textbox", { name: "الاسم" }).fill("Stage screen");
  await page.getByRole("button", { name: "ربط", exact: true }).click();
  await expect(screen.locator("html")).toHaveAttribute("dir", "ltr");
  await expect(screen.getByText("The finale", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(screen.getByText("The finale starts in")).toBeVisible();
  await tv.close();
});
