import { expect, test, type Page } from "@playwright/test";
import { openBuilder } from "#e2e/builder.ts";
import { CONTROL_PORT } from "#e2e/paths.ts";

/**
 * The big screen (T-504), in Arabic: a big-screen page that shows only its pairing code until the Devices page pairs it,
 * the Big screen page where the team ticks and orders the scenes, then the ranking, community and poll scenes on the
 * screen itself, the ranking following a new score without a reload, a scene that was not picked never showing, and
 * Revoke sending the screen back to its code. Desktop and phone.
 */

const PAIRING = /[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{4}/;
const CONTROL = `http://127.0.0.1:${CONTROL_PORT}`;

async function expectNoSidewaysScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

async function control(page: Page, path: string, data: object): Promise<void> {
  const answer = await page.request.post(`${CONTROL}${path}`, { data });
  expect(answer.status(), await answer.text()).toBeLessThan(300);
}

test("pairs a big screen, picks and orders its scenes, and shows the ranking, the goal and the poll", async ({
  page,
  browser,
}, info) => {
  test.setTimeout(180_000);
  await openBuilder(page, info.project.name);
  const eventUrl = page.url().replace(/\/quests$/, "");
  const eventId = eventUrl.split("/").at(-1) ?? "";
  await control(page, "/event-status", { eventId, status: "live" });
  await control(page, "/big-screen-seed", { eventId });
  const suffix = `${info.project.name}${Date.now() % 1e6}`;
  await control(page, "/scored", {
    eventId,
    usernames: [`sara_${suffix}`, `khalid_${suffix}`, `noura_${suffix}`],
    points: [150, 90, 40],
  });

  const tv = await browser.newContext();
  const screen = await tv.newPage();
  screen.on("pageerror", (error) => {
    throw error;
  });
  await screen.goto("/ar/screen");
  await expect(screen.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(screen.getByText("بانتظار الربط")).toBeVisible();
  await expect(screen.getByText("أفضل 10")).toHaveCount(0);
  await expect(screen.getByText("ملتقى نجد")).toHaveCount(0);
  const code = (await screen.getByText(PAIRING).textContent()) ?? "";
  expect(code).toMatch(PAIRING);

  await page.goto(`${eventUrl}/devices`);
  await page.getByLabel("الرمز الظاهر على الشاشة").fill(code.toLowerCase());
  await page.getByRole("button", { name: "متابعة" }).click();
  await expect(page.getByText("تقول الشاشة إنها:")).toBeVisible();
  await page.getByRole("textbox", { name: "الاسم" }).fill("شاشة المدخل");
  await page.getByRole("button", { name: "ربط", exact: true }).click();
  await expect(page.getByText("تم الربط. يظهر المحتوى على الشاشة خلال ثوانٍ.")).toBeVisible();

  // The first scene is the ranking, in the board's order, with Western digits.
  await expect(screen.getByText("ملتقى نجد")).toBeVisible({ timeout: 20_000 });
  await expect(screen.getByText("أفضل 10")).toBeVisible();
  const rows = screen.getByRole("listitem");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText(`sara_${suffix}`);
  await expect(rows.nth(0)).toContainText("نقاط: 150");
  await expect(rows.nth(1)).toContainText(`khalid_${suffix}`);
  await expect(rows.nth(2)).toContainText(`noura_${suffix}`);
  await expect(screen.getByText("شاشة المدخل")).toBeVisible();
  await expectNoSidewaysScroll(screen);

  // A new score reaches the open screen within seconds, with no reload.
  await control(page, "/scored", { eventId, usernames: [`zain_${suffix}`], points: [500] });
  await expect(rows.nth(0)).toContainText(`zain_${suffix}`, { timeout: 15_000 });
  await expect(rows).toHaveCount(4);

  // The team picks the poll first, then the goal; the ranking is not picked and never shows.
  await page.goto(`${eventUrl}/big-screen`);
  await expect(page.getByRole("heading", { name: "الشاشة الكبيرة", level: 1 })).toBeVisible();
  await expectNoSidewaysScroll(page);
  const ranking = page.getByRole("checkbox", { name: "الترتيب المباشر (أفضل 10)" });
  const goal = page.getByRole("checkbox", { name: "الهدف الجماعي" });
  const poll = page.getByRole("checkbox", { name: "الاستطلاع المباشر" });
  await expect(ranking).toBeChecked();
  await expect(goal).toBeChecked();
  await expect(poll).toBeChecked();
  await ranking.uncheck();
  await page.getByRole("button", { name: "نقل «الاستطلاع المباشر» إلى الأعلى" }).click();
  await page.getByRole("button", { name: "نقل «الاستطلاع المباشر» إلى الأعلى" }).click();
  await page.getByRole("button", { name: "حفظ المشاهد" }).click();
  await expect(page.getByText("حُفظت المشاهد. تتحدّث الشاشات خلال ثوانٍ.")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("checkbox", { name: "الترتيب المباشر (أفضل 10)" })).not.toBeChecked();

  // The poll comes first (its results are open to a voter), then the goal; the ranking never returns.
  await expect(screen.getByText("استطلاع مباشر")).toBeVisible({ timeout: 20_000 });
  await expect(screen.getByText("ما المجال الأجمل؟")).toBeVisible();
  await expect(screen.getByText("الروبوتات")).toBeVisible();
  await expect(screen.getByText(/^2 · 67%$/)).toBeVisible();
  await expect(screen.getByText("صوّت 3")).toBeVisible();
  await expect(screen.getByText("أفضل 10")).toHaveCount(0);
  await expectNoSidewaysScroll(screen);
  await expect(screen.getByText("الهدف الجماعي")).toBeVisible({ timeout: 30_000 });
  await expect(screen.getByText("أضيئوا البرج")).toBeVisible();
  await expect(screen.getByText("40 من 100")).toBeVisible();
  await expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "40");
  await expect(screen.getByText("أفضل 10")).toHaveCount(0);

  // Revoke sends the screen back to its pairing code.
  await page.goto(`${eventUrl}/devices`);
  const device = page.getByRole("listitem").filter({ hasText: "شاشة المدخل" });
  await device.getByRole("button", { name: "إلغاء الربط" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "إلغاء الربط" }).click();
  await expect(device).toContainText("أُلغي ربطه");
  await expect(screen.getByText("بانتظار الربط")).toBeVisible({ timeout: 20_000 });
  await expect(screen.getByText("أضيئوا البرج")).toHaveCount(0);
  await tv.close();
});

test("a big screen without the add-on says so, and the Big screen page says the same", async ({
  page,
  browser,
}, info) => {
  test.setTimeout(120_000);
  await openBuilder(page, info.project.name);
  const eventUrl = page.url().replace(/\/quests$/, "");
  const eventId = eventUrl.split("/").at(-1) ?? "";
  await control(page, "/event-status", { eventId, status: "live" });

  await page.goto(`${eventUrl}/big-screen`);
  await expect(
    page.getByText("الشاشة الكبيرة غير مفعّلة لهذه الفعالية. تواصل مع كويستفاي لتفعيلها."),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "حفظ المشاهد" })).toBeDisabled();

  const tv = await browser.newContext();
  const screen = await tv.newPage();
  await screen.goto("/en/screen");
  const code = (await screen.getByText(PAIRING).textContent()) ?? "";
  await page.goto(`${eventUrl}/devices`);
  await page.getByLabel("الرمز الظاهر على الشاشة").fill(code);
  await page.getByRole("button", { name: "متابعة" }).click();
  await page.getByRole("textbox", { name: "الاسم" }).fill("Lobby TV");
  await page.getByRole("button", { name: "ربط", exact: true }).click();
  await expect(screen.getByText("The big screen isn't active for this event")).toBeVisible({
    timeout: 20_000,
  });
  await expect(screen.getByText("Top 10")).toHaveCount(0);
  await tv.close();
});

test("an English big screen reads left to right with Western digits", async ({
  page,
  browser,
}, info) => {
  test.setTimeout(120_000);
  await openBuilder(page, info.project.name);
  const eventUrl = page.url().replace(/\/quests$/, "");
  const eventId = eventUrl.split("/").at(-1) ?? "";
  await control(page, "/event-status", { eventId, status: "live" });
  await control(page, "/big-screen-seed", { eventId });
  await control(page, "/scored", {
    eventId,
    usernames: [`lina_${info.project.name}`],
    points: [1200],
  });
  const tv = await browser.newContext();
  const screen = await tv.newPage();
  await screen.goto("/en/screen");
  await expect(screen.locator("html")).toHaveAttribute("dir", "ltr");
  const code = (await screen.getByText(PAIRING).textContent()) ?? "";
  await page.goto(`${eventUrl}/devices`);
  await page.getByLabel("الرمز الظاهر على الشاشة").fill(code);
  await page.getByRole("button", { name: "متابعة" }).click();
  await page.getByRole("textbox", { name: "الاسم" }).fill("Lobby TV");
  await page.getByRole("button", { name: "ربط", exact: true }).click();
  await expect(screen.getByText("Top 10")).toBeVisible({ timeout: 20_000 });
  await expect(screen.getByRole("listitem").first()).toContainText("1,200 points");
  await tv.close();
});
