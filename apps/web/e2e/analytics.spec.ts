import { readFileSync } from "node:fs";
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
const BOM = String.fromCharCode(0xfeff);
const LINE_BREAK = String.fromCharCode(13, 10);

/** Clicks a button that saves a file and reads what was saved. */
async function savedFile(page: Page, name: string): Promise<string> {
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name, exact: true }).click(),
  ]);
  return readFileSync(await download.path(), "utf8");
}
const tile = (page: Page, name: string) => page.getByRole("region", { name, exact: true });

/**
 * The cards that sit in one row are as tall as each other (ADR-392 (6)). Returns how many rows held more than one of
 * the named cards, so a page too narrow to put two side by side is not mistaken for a pass.
 */
async function expectRowsEqualHeight(page: Page, names: readonly string[]): Promise<number> {
  const boxes = await Promise.all(names.map((name) => tile(page, name).boundingBox()));
  const rows = new Map<number, number[]>();
  for (const [index, box] of boxes.entries()) {
    expect(box, `${names[index]} is on the page`).not.toBeNull();
    const top = Math.round(box?.y ?? 0);
    const row = [...rows.keys()].find((key) => Math.abs(key - top) <= 1) ?? top;
    rows.set(row, [...(rows.get(row) ?? []), box?.height ?? 0]);
  }
  for (const [top, heights] of rows) {
    for (const height of heights) {
      expect(height, `the cards of the row at ${top}px have one height`).toBeCloseTo(
        heights[0] ?? 0,
        0,
      );
    }
  }
  return [...rows.values()].filter((heights) => heights.length > 1).length;
}

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

  // The line in words for a screen reader, always on the page; a tap opens the readout and a lifted finger leaves it.
  const line = page.getByRole("group", { name: "الانضمام عبر الوقت" });
  await expect(line).toHaveAccessibleDescription(
    /^عدد الفترات: \d+\. الأولى، .*: \d+\. الأخيرة، .*: 10\.$/,
  );
  await expect(line.getByRole("status")).toHaveCount(0);
  const plot = await line.boundingBox();
  const touch = {
    pointerType: "touch",
    clientX: (plot?.x ?? 0) + 2,
    clientY: (plot?.y ?? 0) + (plot?.height ?? 0) / 2,
  };
  await line.dispatchEvent("pointerdown", touch);
  await expect(line.getByRole("status")).not.toHaveText(/: 10$/);
  await line.dispatchEvent("pointerout", touch);
  await expect(line.getByRole("status")).toHaveCount(1);
  await line.dispatchEvent("pointerout", { ...touch, pointerType: "mouse" });
  await expect(line.getByRole("status")).toHaveCount(0);

  // The line, read with the keyboard: the last point first, then one back.
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
  await expect(rewards.getByRole("listitem").first()).toContainText("الاستبدال: 2");
  await expect(rewards.getByRole("listitem").first()).toContainText("1 لم تُستلم · 3 متبقية");

  const rows = await expectRowsEqualHeight(page, [
    "المنضمّون",
    "النشطون",
    "نسبة النشطين",
    "العائدون",
    "الانضمام عبر الوقت",
    "طريقة الانضمام",
    "الأكثر إنجازًا",
    "الأقل إنجازًا",
    "مسار التقدم في فئة",
    "أين يتوقف لاعبون",
    "المكتسب من نقاط",
    "المنفق من نقاط",
    "حجوزات لم تُستلم",
  ]);
  if (info.project.name === "desktop") {
    expect(rows).toBeGreaterThanOrEqual(5);
  }

  // No time-spent figure and no heatmap anywhere (FR-1203).
  await expect(page.getByText(/خريطة حرارية|time spent|heatmap/i)).toHaveCount(0);
  await checkLayout(page, info.project.name, "ar analytics");

  // The spreadsheets (T-608): the players file holds a username, the status, when they joined and their points, and no
  // contact detail; a sponsor's file holds totals and no player.
  const players = await savedFile(page, "تصدير لاعبون");
  expect(players.startsWith(BOM)).toBe(true);
  const playerLines = players.slice(1).trimEnd().split(LINE_BREAK);
  expect(playerLines[0]).toBe("اسم المستخدم,الحالة,وقت الانضمام,النقاط");
  expect(playerLines).toHaveLength(11);
  expect(players).not.toMatch(/@|\+966/);
  const completions = await savedFile(page, "تصدير الإنجازات");
  expect(completions.trimEnd().split(LINE_BREAK)).toHaveLength(1 + 8 + 6 + 2 + 1 + 5 + 3 + 1);

  // The sponsor filter: totals instead of the event's figures, a count of one to four players in words, and the
  // sponsor's file in place of the player files.
  const filter = page.getByLabel("الراعي", { exact: true });
  await filter.selectOption({ label: "أكمي" });
  await expect(page.getByRole("heading", { name: "إجماليات أكمي" })).toBeVisible();
  await expect(tile(page, "الزيارات")).toContainText("8");
  await expect(tile(page, "الإنجازات")).toContainText("8");
  await expect(tile(page, "الاستبدالات")).toContainText("0");
  await expect(page.getByRole("button", { name: "تصدير لاعبون" })).toHaveCount(0);
  const sponsorFile = await savedFile(page, "تصدير إجماليات الراعي");
  expect(sponsorFile.slice(1).trimEnd().split(LINE_BREAK)).toEqual([
    "المجموعة,العنصر,المقياس,العدد",
    "الإجماليات,أكمي,الزيارات,8",
    "الإجماليات,,الإنجازات,8",
    "الإجماليات,,الاستبدالات,0",
    "المهمة,الخطوة 1,اللاعبون,8",
  ]);
  await filter.selectOption({ label: "الهادئة" });
  await expect(tile(page, "الزيارات")).toContainText("أقل من 5");
  await expect(tile(page, "الاستبدالات")).toContainText("أقل من 5");
  await expect(page.getByText("الخطوة 4")).toBeVisible();
  await expect(page.getByText("لاعبون: 1")).toHaveCount(0);
  await checkLayout(page, info.project.name, "ar analytics sponsor");
  await filter.selectOption({ label: "كل الرعاة" });

  // The one-page report: the page prints alone on one A4 page, with Arabic type and Western digits.
  await page.getByRole("link", { name: "تقرير من صفحة واحدة" }).click();
  await expect(page.getByRole("heading", { name: "تقرير الفعالية", level: 1 })).toBeVisible();
  const sheet = page.getByRole("article");
  await expect(sheet.getByRole("heading", { level: 2 })).toBeVisible();
  await expect(tile(page, "المنضمّون")).toContainText("10");
  await expect(sheet).toContainText("الخطوة 1");
  await expect(sheet).not.toContainText(/@|an\d+_/);
  await checkLayout(page, info.project.name, "ar report");
  // The button records the print (204) and only then opens the print dialog.
  await page.evaluate(() => {
    const counted = window as unknown as { printed: number };
    counted.printed = 0;
    window.print = () => {
      counted.printed += 1;
    };
  });
  const recorded = page.waitForResponse(
    (response) => response.url().endsWith("/report") && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "طباعة أو حفظ PDF" }).click();
  expect((await recorded).status()).toBe(204);
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { printed: number }).printed))
    .toBe(1);
  await page.emulateMedia({ media: "print" });
  await expect(page.getByRole("heading", { name: "تقرير الفعالية", level: 1 })).toBeHidden();
  await expect(sheet).toBeVisible();
  const pdf = await page.pdf({ preferCSSPageSize: true });
  expect(pdf.toString("latin1").match(/\/Type\s*\/Page[^s]/g)).toHaveLength(1);
  await page.emulateMedia({ media: "screen" });

  await page.goto(
    page
      .url()
      .replace("/ar/", "/en/")
      .replace(/\/analytics\/report$/, "/analytics"),
  );
  await expect(page.getByRole("heading", { name: "Analytics", level: 1 })).toBeVisible();
  await expect(tile(page, "Joined")).toContainText("10");
  await expect(tile(page, "Activation rate")).toContainText("80%");
  await expect(tile(page, "Points earned")).toContainText("500");
  await expect(page.getByRole("region", { name: "Redemptions per reward" })).toContainText(
    "2 redeemed",
  );
  await checkLayout(page, info.project.name, "en analytics");
});
