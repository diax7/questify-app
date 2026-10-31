import { expect, test, type Page } from "@playwright/test";
import { openBuilder } from "#e2e/builder.ts";
import { openMenu } from "#e2e/nav.ts";

const ORIGIN = "http://localhost:3100";

/** Calls the API as the signed-in organizer through the web origin, as the future assistant will. */
async function api(page: Page, method: "GET" | "POST", path: string, data?: object) {
  const response = await page.request.fetch(path, {
    method,
    headers: { origin: ORIGIN, "idempotency-key": crypto.randomUUID() },
    ...(data === undefined ? {} : { data }),
  });
  expect(response.status(), `${method} ${path}`).toBeLessThan(300);
  return (await response.json()) as Record<string, any>;
}

/**
 * Change sets (T-604b, FR-1034, FR-1035), in Arabic: a set made through the API lists each change with what it is now and
 * what it becomes, marks one that cannot work as invalid, applies only the selected ones after a confirmation that lists
 * them, and closes without applying the rest.
 */
test("reviews a change set, applies the selected items and closes the rest", async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  await openBuilder(page, info.project.name);
  const url = /organizers\/([0-9a-f-]{36})\/events\/([0-9a-f-]{36})/.exec(page.url());
  const base = `/v1/organizers/${url?.[1]}/events/${url?.[2]}`;
  const builder = await api(page, "GET", `${base}/quests`);
  const category = builder["categories"][0].id as string;
  const made = await api(page, "POST", `${base}/quests`, {
    categoryId: category,
    type: "scan_qr",
    title: { ar: "الصقر", en: "Falcon" },
    points: 40,
  });
  const quest = made["quest"].id as string;
  await api(page, "POST", `${base}/change-sets`, {
    items: [
      { op: "edit", target: "quest", targetId: quest, body: { points: 90 } },
      {
        op: "add",
        target: "quest",
        body: {
          categoryId: category,
          type: "scan_qr",
          title: { ar: "القاعة", en: "Hall" },
          points: 10,
        },
      },
      { op: "edit", target: "quest", targetId: crypto.randomUUID(), body: { points: 5 } },
    ],
  });

  await page.goto(page.url().replace(/\/quests$/, ""));
  await openMenu(page);
  await page.getByRole("link", { name: "مجموعات التغييرات" }).click();
  await expect(page.getByRole("heading", { name: "مجموعات التغييرات", level: 1 })).toBeVisible();
  await expect(page.getByText("التغييرات: 3 · بانتظار القرار: 3")).toBeVisible();
  await page.getByRole("button", { name: "مراجعة" }).click();

  const items = page.getByRole("listitem");
  const edit = items.filter({ hasText: "الصقر" });
  await expect(edit).toContainText("الآن: 40");
  await expect(edit).toContainText("الجديد: 90");
  await expect(items.filter({ hasText: "القاعة" })).toContainText("الجديد: 10");
  const invalid = items.filter({ hasText: "غير صالح" });
  await expect(invalid).toHaveCount(1);
  await expect(invalid.getByRole("checkbox")).toHaveCount(0);

  await page.getByRole("button", { name: "تحديد الجاهز" }).click();
  await page.getByRole("button", { name: "تطبيق المحدد" }).click();
  const asking = page.getByRole("alertdialog");
  await expect(asking).toContainText("تطبيق التغييرات المحددة؟");
  await expect(asking).toContainText("الجديد: 90");
  await asking.getByRole("button", { name: "إلغاء" }).click();
  const unchanged = await api(page, "GET", `${base}/quests`);
  expect(unchanged["categories"][0].quests.map((one: { points: number }) => one.points)).toEqual([
    40,
  ]);

  await page.getByRole("button", { name: "تطبيق المحدد" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "تطبيق", exact: true }).click();
  await expect(page.getByText("طُبّق: 2. فشل: 0. تغيّر الهدف: 0.")).toBeVisible();
  await expect(items.filter({ hasText: "طُبّق" })).toHaveCount(2);
  const applied = await api(page, "GET", `${base}/quests`);
  expect(applied["categories"][0].quests.map((one: { points: number }) => one.points)).toEqual([
    90, 10,
  ]);

  await page.getByRole("button", { name: "إغلاق دون تطبيق" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "إغلاق المجموعة" }).click();
  await expect(page.getByText("أُغلقت المجموعة.")).toBeVisible();
  await expect(page.getByRole("button", { name: "تطبيق المحدد" })).toHaveCount(0);

  await page.goto(page.url().replace("/ar/", "/en/"));
  await expect(page.getByRole("heading", { name: "Change sets", level: 1 })).toBeVisible();
});
