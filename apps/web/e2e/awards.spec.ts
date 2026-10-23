import { expect, test } from "@playwright/test";
import { openBuilder } from "#e2e/builder.ts";
import { CONTROL_PORT } from "#e2e/paths.ts";

/**
 * Manual awards (T-207) on a live event: the owner awards and removes points on the Players page, sets the caps,
 * bulk-awards a pasted list after a preview, and reads the report, in both languages.
 */
test("the owner awards, removes and bulk-awards points", async ({ page, request }, info) => {
  test.setTimeout(90_000);
  await openBuilder(page, info.project.name);
  const eventId = /\/events\/([0-9a-f-]{36})\/quests/.exec(page.url())?.[1];
  const tag = `${info.project.name.slice(0, 2)}${Date.now() % 1_000_000}`;
  const control = `http://127.0.0.1:${CONTROL_PORT}`;
  const seeded = await request.post(`${control}/players`, {
    data: { eventId, usernames: [`falcon_${tag}`, `oryx_${tag}`] },
  });
  expect(seeded.status()).toBe(204);
  const live = await request.post(`${control}/event-status`, { data: { eventId, status: "live" } });
  expect(live.status()).toBe(204);

  await page.goto(page.url().replace(/\/quests$/, "/players"));
  const falcon = page
    .getByRole("listitem")
    .filter({ hasText: `@falcon_${tag}` })
    .first();
  await falcon.getByRole("button", { name: "سجل النقاط" }).click();
  await expect(page.getByText("أنت المالك: لا حد لمنحك.")).toBeVisible();
  await expect(page.getByText("لا شيء في السجل بعد.")).toBeVisible();
  const form = page.getByRole("form", { name: `منح @falcon_${tag}` });
  await expect(form.getByRole("button", { name: "منح", exact: true })).toBeDisabled();
  await form.getByLabel("عدد النقاط").fill("50");
  await form.getByLabel("السبب (مطلوب)").fill("ساعد في تنظيم الطابور");
  await form.getByRole("button", { name: "منح", exact: true }).click();
  const confirm = page.getByRole("alertdialog");
  await expect(confirm).toContainText(`يحصل @falcon_${tag} على 50. السبب: ساعد في تنظيم الطابور`);
  await confirm.getByRole("button", { name: "تأكيد" }).click();
  await expect(page.getByRole("status")).toHaveText(`مُنح @falcon_${tag} 50. حُفظ السبب.`);
  await expect(page.getByText("ساعد في تنظيم الطابور")).toBeVisible();

  await page.getByRole("button", { name: "إزالة", exact: true }).click();
  const removal = page.getByRole("alertdialog");
  await expect(removal.getByRole("heading")).toHaveText(`إزالة 50 من @falcon_${tag}؟`);
  await expect(removal.getByRole("button", { name: "تأكيد" })).toBeDisabled();
  await removal.getByLabel("السبب (مطلوب)").fill("منح بالخطأ");
  await removal.getByRole("button", { name: "تأكيد" }).click();
  await expect(page.getByRole("status")).toHaveText("أُزيلت النقاط. حُفظ السبب.");
  await expect(page.getByText("إزالة نقاط")).toBeVisible();
  await expect(page.getByText("أُزيلت", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "إزالة", exact: true })).toHaveCount(0);

  await page.goto(page.url().replace(/\/players$/, "/awards"));
  await expect(page.getByRole("heading", { name: "المنح اليدوي", level: 2 })).toBeVisible();
  await page.getByLabel("الحد للمنح الواحد").fill("100");
  await page.getByLabel("الحد اليومي لكل شخص").fill("50");
  await page.getByRole("button", { name: "حفظ الحدود" }).click();
  await expect(page.getByText("الحد اليومي يجب ألا يقل عن حد المنح الواحد.")).toBeVisible();
  await page.getByLabel("الحد اليومي لكل شخص").fill("400");
  await page.getByRole("button", { name: "حفظ الحدود" }).click();
  await expect(page.getByText("حُفظت الحدود.")).toBeVisible();

  const bulk = page.getByRole("region", { name: "منح جماعي" });
  await bulk
    .getByLabel("أسماء المستخدمين أو أرقام الجوال، واحد في كل سطر")
    .fill(`falcon_${tag}\n@ORYX_${tag}\nnobody_${tag}`);
  await bulk.getByRole("button", { name: "تحقّق" }).click();
  await expect(bulk.getByText("سيحصل على النقاط: 2")).toBeVisible();
  await expect(bulk.getByText(`غير موجودين: nobody_${tag}`)).toBeVisible();
  await expect(bulk.getByRole("button", { name: "منح", exact: true })).toBeDisabled();
  await bulk.getByLabel("عدد النقاط").fill("25");
  await bulk.getByLabel("السبب (مطلوب)").fill("فريق الفائزين في الورشة");
  await bulk.getByRole("button", { name: "منح", exact: true }).click();
  await expect(page.getByRole("alertdialog")).toContainText(
    "يحصل كل واحد من 2 على 25. السبب: فريق الفائزين في الورشة",
  );
  await page.getByRole("alertdialog").getByRole("button", { name: "تأكيد" }).click();
  await expect(bulk.getByRole("status")).toHaveText("مُنح 2، وتُخطّي 0.");

  const report = page.getByRole("listitem");
  await expect(report.filter({ hasText: "منح جماعي" })).toHaveCount(2);
  await expect(report.filter({ hasText: "منح بالخطأ" })).toContainText("إزالة نقاط");
  await expect(report.filter({ hasText: "ساعد في تنظيم الطابور" })).toContainText("أُزيلت");

  await page.goto(page.url().replace("/ar/", "/en/"));
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  await expect(page.getByRole("heading", { name: "Award report" })).toBeVisible();
  await expect(
    page
      .getByRole("listitem")
      .filter({ hasText: `@oryx_${tag}` })
      .filter({ hasText: "Bulk award" }),
  ).toContainText("+25");
});
