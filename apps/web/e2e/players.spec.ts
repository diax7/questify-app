import { expect, test } from "@playwright/test";
import { openBuilder } from "#e2e/builder.ts";
import { CONTROL_PORT } from "#e2e/paths.ts";

/** The event's players page (T-208): the owner bans and lifts a ban, and keeps the exclusion list, in both languages. */
test("the owner bans a player and keeps the exclusion list", async ({ page, request }, info) => {
  test.setTimeout(90_000);
  await openBuilder(page, info.project.name);
  const eventId = /\/events\/([0-9a-f-]{36})\/quests/.exec(page.url())?.[1];
  const tag = `${info.project.name.slice(0, 2)}${Date.now() % 1_000_000}`;
  const seeded = await request.post(`http://127.0.0.1:${CONTROL_PORT}/players`, {
    // 27 players: one more page than the list's 25, for "Show more".
    data: {
      eventId,
      usernames: [
        `falcon_${tag}`,
        `oryx_${tag}`,
        ...Array.from({ length: 25 }, (_, i) => `ibex${i}_${tag}`),
      ],
    },
  });
  expect(seeded.status()).toBe(204);

  await page.goto(page.url().replace(/\/quests$/, "/players"));
  await expect(page.getByRole("heading", { name: "لاعبون", level: 2 })).toBeVisible();
  const falcon = page.getByRole("listitem").filter({ hasText: `@falcon_${tag}` });
  await expect(falcon).toContainText("يلعب");
  await falcon.getByRole("button", { name: "حظر" }).click();
  await expect(page.getByRole("heading", { name: `حظر falcon_${tag}؟` })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(falcon.getByRole("button", { name: "حظر" })).toBeFocused();
  await falcon.getByRole("button", { name: "حظر" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "حظر" }).click();
  await expect(page.getByRole("status")).toHaveText(`حُظر falcon_${tag}.`);
  await expect(falcon).toContainText("محظور");
  await page.reload();
  await expect(page.getByRole("listitem").filter({ hasText: `@falcon_${tag}` })).toContainText(
    "محظور",
  );

  // Text typed but not searched does not change what "Show more" loads.
  await page.getByRole("searchbox", { name: "ابحث باسم المستخدم" }).fill("zz");
  await page.getByRole("button", { name: "عرض المزيد" }).click();
  await expect(page.getByRole("listitem").filter({ hasText: "@" })).toHaveCount(27);
  await page.getByRole("searchbox", { name: "ابحث باسم المستخدم" }).fill(`ORYX_${tag}`);
  await page.getByRole("searchbox", { name: "ابحث باسم المستخدم" }).press("Enter");
  await expect(page.getByRole("listitem").filter({ hasText: "@" })).toHaveCount(1);

  await page.getByLabel("الرقم أو النطاق").fill("055 123 4567");
  await page.getByRole("button", { name: "إضافة" }).click();
  await expect(page.locator("bdi", { hasText: "•••• 4567" })).toBeVisible();
  await page.getByLabel("النوع").selectOption("email_domain");
  await page.getByLabel("الرقم أو النطاق").fill("sponsor.sa");
  await page.getByRole("button", { name: "إضافة" }).click();
  await expect(page.getByText("2 من 500")).toBeVisible();
  await page.getByLabel("الرقم أو النطاق").fill("not a domain");
  await page.getByRole("button", { name: "إضافة" }).click();
  await expect(page.getByText("أدخل رقم جوال سعوديًا أو نطاق بريد مثل company.com.")).toBeVisible();
  await page.getByRole("button", { name: "حذف •••• 4567" }).click();
  await expect(page.getByText("1 من 500")).toBeVisible();

  await page.goto(page.url().replace("/ar/", "/en/"));
  await expect(page.getByRole("heading", { name: "Exclusion list" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  const banned = page.getByRole("listitem").filter({ hasText: `@falcon_${tag}` });
  await banned.getByRole("button", { name: "Lift the ban" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Lift the ban" }).click();
  await expect(banned).toContainText("Playing");
});
