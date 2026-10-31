import { expect, test, type Page } from "@playwright/test";
import { openBuilder } from "#e2e/builder.ts";
import {
  expectCleanLayout,
  expectStateContrast,
  waitUntilSettled,
  watchRequests,
} from "#e2e/layout.ts";
import { openMenu } from "#e2e/nav.ts";
import { CONTROL_PORT } from "#e2e/paths.ts";

/**
 * The analytics page (T-607), in Arabic: figures of zero and no activation value for an event nobody joined, then ten
 * players who joined by every source, the most and least popular quests with "View more", a category's funnel with its
 * largest drop, where players stop, the points and the redemptions per reward, the chart read by keyboard; and the
 * English headings.
 */
/** The filled page read as the layout check reads every page: no overflow, overlap, small text or nested box. */
async function checkLayout(page: Page, project: string, where: string): Promise<void> {
  await page.evaluate(() => window.scrollTo(0, 0));
  await waitUntilSettled(page, where);
  await expectCleanLayout(page, where);
  if (project === "desktop") {
    await expectStateContrast(page, where, "body");
  }
}
const tile = (page: Page, name: string) => page.getByRole("region", { name, exact: true });

test("shows the event's analytics from nothing to a played event", async ({
  page,
  request,
}, info) => {
  test.setTimeout(150_000);
  await openBuilder(page, info.project.name);
  // The quest page reads its quests and items after it draws; leaving before they arrive leaves requests the settle check would wait for.
  await page.waitForLoadState("networkidle");
  watchRequests(page);
  const event = page.url().replace(/\/quests$/, "");
  const eventId = /\/events\/([0-9a-f-]{36})/.exec(event)?.[1];

  await page.goto(event);
  await openMenu(page);
  await page.getByRole("link", { name: "التحليلات" }).click();
  await expect(page.getByRole("heading", { name: "التحليلات", level: 1 })).toBeVisible();
  await expect(tile(page, "المنضمّون")).toContainText("0");
  await expect(tile(page, "نسبة النشطين")).toContainText("—");
  await expect(page.getByRole("region", { name: "الانضمام عبر الوقت", exact: true })).toContainText(
    "لا أرقام بعد.",
  );
  await expect(page.getByRole("button", { name: /^عرض المزيد/ })).toHaveCount(0);

  const seeded = await request.post(`http://127.0.0.1:${CONTROL_PORT}/analytics-seed`, {
    data: { eventId },
  });
  expect(seeded.status()).toBe(204);
  await page.reload();
  await expect(tile(page, "المنضمّون")).toContainText("10");
  await expect(tile(page, "النشطون")).toContainText("8");
  await expect(tile(page, "نسبة النشطين")).toContainText("80%");
  await expect(tile(page, "العائدون")).toContainText("0");

  const sources = page.getByRole("region", { name: "طريقة الانضمام", exact: true });
  await expect(sources.getByRole("listitem")).toHaveCount(6);
  await expect(sources.getByRole("listitem").filter({ hasText: "رمز الانضمام" })).toContainText(
    "2 (20%)",
  );
  await expect(sources.getByRole("listitem").filter({ hasText: "أخرى" })).toContainText("0 (0%)");

  // The line, read with the keyboard: the last point first, then one back.
  const line = page.getByRole("group", { name: "الانضمام عبر الوقت" });
  await line.focus();
  await expect(line.getByRole("status")).toHaveText(/: 10$/);
  const latest = await line.getByRole("status").textContent();
  await line.press("Home");
  await expect(line.getByRole("status")).not.toHaveText(latest ?? "");

  await page.getByRole("button", { name: "عرض المزيد: الانضمام عبر الوقت" }).click();
  const points = page.getByRole("dialog", { name: "الانضمام عبر الوقت" });
  await expect(points.getByRole("listitem").first()).toContainText("10");
  await points.getByRole("button", { name: "إغلاق" }).click();
  await expect(points).toHaveCount(0);

  const most = page.getByRole("region", { name: "الأكثر إنجازًا", exact: true });
  await expect(most.getByRole("listitem")).toHaveCount(5);
  await expect(most.getByRole("listitem").first()).toContainText("الخطوة 1");
  await expect(most.getByRole("listitem").first()).toContainText("8 (80%)");
  const least = page.getByRole("region", { name: "الأقل إنجازًا", exact: true });
  await expect(least.getByRole("listitem").first()).toContainText("مهمة حرة 4");
  await expect(least.getByRole("listitem").first()).toContainText("0 (0%)");
  await page.getByRole("button", { name: "عرض المزيد: الأكثر إنجازًا" }).click();
  const all = page.getByRole("dialog", { name: "الأكثر إنجازًا" });
  await expect(all.getByRole("listitem")).toHaveCount(8);
  await all.getByRole("button", { name: "إغلاق" }).click();

  const funnel = page.getByRole("region", { name: "مسار التقدم في فئة", exact: true });
  await expect(funnel).toContainText("بالترتيب");
  await expect(funnel).toContainText("بعد «الخطوة 2»: توقف 4 (67%)");
  await expect(funnel.getByRole("listitem")).toHaveCount(4);
  await expect(funnel.getByRole("listitem").filter({ hasText: "أكبر انخفاض" })).toContainText(
    "الخطوة 3",
  );
  await funnel.getByLabel("اختر فئة").selectOption({ label: "حرة" });
  await expect(funnel).toContainText("بأي ترتيب");
  await expect(funnel.getByText("أكبر انخفاض")).toHaveCount(0);

  const stops = page.getByRole("region", { name: "أين يتوقف لاعبون", exact: true });
  await expect(stops.getByRole("listitem")).toHaveCount(1);
  await expect(stops).toContainText("الدرب");
  await expect(stops).toContainText("بعد «الخطوة 2»");

  await expect(tile(page, "المكتسب من نقاط")).toContainText("500");
  await expect(tile(page, "المنفق من نقاط")).toContainText("70");
  await expect(tile(page, "حجوزات لم تُستلم")).toContainText("2");
  const rewards = page.getByRole("region", { name: "الاستبدال لكل جائزة", exact: true });
  await expect(rewards.getByRole("listitem")).toHaveCount(2);
  await expect(rewards.getByRole("listitem").first()).toContainText("هودي الفعالية");
  await expect(rewards.getByRole("listitem").first()).toContainText("2 استبدال");
  await expect(rewards.getByRole("listitem").first()).toContainText("1 لم تُستلم · 3 متبقية");

  // No time-spent figure and no heatmap anywhere (FR-1203).
  await expect(page.getByText(/خريطة حرارية|time spent|heatmap/i)).toHaveCount(0);
  await checkLayout(page, info.project.name, "ar analytics");

  await page.goto(page.url().replace("/ar/", "/en/"));
  await expect(page.getByRole("heading", { name: "Analytics", level: 1 })).toBeVisible();
  await expect(tile(page, "Joined")).toContainText("10");
  await expect(tile(page, "Activation rate")).toContainText("80%");
  await expect(tile(page, "Points earned")).toContainText("500");
  await expect(page.getByRole("region", { name: "Redemptions per reward" })).toContainText(
    "2 redeemed",
  );
  await checkLayout(page, info.project.name, "en analytics");
});
