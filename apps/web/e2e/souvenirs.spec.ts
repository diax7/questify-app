import { test, expect } from "@playwright/test";
import { openBuilder } from "#e2e/builder.ts";
import { openMenu } from "#e2e/nav.ts";

test("creates and edits bilingual souvenirs, reviews each audience, activates and stops a permanent promise", async ({
  page,
}, info) => {
  test.setTimeout(90_000);
  await openBuilder(page, info.project.name);
  const event = page.url().replace(/\/quests$/, "");
  await page.goto(event);
  const apiPath = `${new URL(event).pathname.replace(/^\/ar\//, "/v1/")}/souvenirs`;
  await openMenu(page);
  const [loaded] = await Promise.all([
    page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === apiPath && response.request().method() === "GET",
      { timeout: 10_000 },
    ),
    page.getByRole("link", { name: "تذكارات الفعالية" }).click(),
  ]);
  expect(loaded.status()).toBe(200);
  await expect(page.getByRole("heading", { name: "تذكارات الفعالية" })).toBeVisible();
  await page.getByRole("button", { name: "أضف تذكارًا" }).click();
  await page.getByLabel("الاسم بالعربية").fill("تذكار نجد");
  await page.getByLabel("الاسم بالإنجليزية").fill("Najd souvenir");
  await page.getByLabel("المستحقون").selectOption("rank");
  await page.getByLabel("من المركز").fill("4");
  await page.getByLabel("إلى المركز").fill("20");
  await expect(page.getByText(/لأصحاب المراكز من 4 إلى 20/)).toBeVisible();
  await page.getByLabel("المستحقون").selectOption("category");
  await expect(page.getByText(/عند التفعيل، يثبت المطلوب/)).toBeVisible();
  await page.getByLabel("المستحقون").selectOption("all");
  await expect(page.getByText(/عند التفعيل، يثبت المطلوب/)).toBeVisible();
  await page.getByLabel("المستحقون").selectOption("joined");
  await expect(page.getByText(/عند التفعيل، يثبت المطلوب/)).toHaveCount(0);
  await page.getByRole("button", { name: "احفظ المسودة" }).click();
  const card = page.getByRole("article").filter({ hasText: "تذكار نجد" });
  await expect(card.getByText(/^مسودة ·/)).toBeVisible();
  await card.getByRole("button", { name: "عدّل المسودة" }).click();
  await page.getByLabel("الاسم بالعربية").fill("تذكار الرحلة");
  await page.getByRole("button", { name: "احفظ المسودة" }).click();
  const edited = page.getByRole("article").filter({ hasText: "تذكار الرحلة" });
  await edited.getByRole("button", { name: "فعّل التذكار" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog.getByText(/للمشاركين المقبولين/)).toBeVisible();
  await expect(dialog.getByText(/ما كسبه اللاعب يبقى له/)).toBeVisible();
  await dialog.getByRole("button", { name: "فعّل التذكار" }).click();
  await expect(edited.getByText("نشط", { exact: false })).toBeVisible();
  await edited.getByRole("button", { name: "أوقف المنح" }).click();
  await dialog.getByRole("button", { name: "أوقف المنح" }).click();
  await expect(edited.getByText("متوقف", { exact: false })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(overflow).toBe(false);
});
