import { expect, test } from "@playwright/test";
import { openBuilder } from "#e2e/builder.ts";
import { CONTROL_PORT } from "#e2e/paths.ts";

/**
 * Submissions (T-301) on a live event: the owner reads the queue, approves one, rejects one only after giving a
 * reason, finds both under Reviewed, and removes the approved one with a reason, in Arabic.
 */
test("the owner reviews and removes submissions", async ({ page, request }, info) => {
  test.setTimeout(90_000);
  await openBuilder(page, info.project.name);
  const eventId = /\/events\/([0-9a-f-]{36})\/quests/.exec(page.url())?.[1];
  const tag = `${info.project.name.slice(0, 2)}${Date.now() % 1_000_000}`;
  const control = `http://127.0.0.1:${CONTROL_PORT}`;
  const live = await request.post(`${control}/event-status`, { data: { eventId, status: "live" } });
  expect(live.status()).toBe(204);
  const seeded = await request.post(`${control}/submitted`, {
    data: {
      eventId,
      usernames: [`falcon_${tag}`, `oryx_${tag}`],
      texts: ["بنينا روبوتًا يرتب الكتب", "لا شيء"],
    },
  });
  expect(seeded.status()).toBe(204);

  await page.goto(page.url().replace(/\/quests$/, "/submissions"));
  await expect(page.getByRole("heading", { name: "المشاركات", level: 2 })).toBeVisible();
  await expect(page.getByRole("tab", { name: "بانتظار المراجعة" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const items = page.getByTestId("submission");
  await expect(items).toHaveCount(2);

  const falcon = items.filter({ hasText: `@falcon_${tag}` });
  await expect(falcon).toContainText("بنينا روبوتًا يرتب الكتب");
  await falcon.getByRole("button", { name: "اقبل" }).click();
  await expect(items).toHaveCount(1);

  const oryx = items.filter({ hasText: `@oryx_${tag}` });
  await expect(oryx.getByRole("button", { name: "ارفض" })).toBeDisabled();
  await oryx.getByLabel("سبب الرفض (يراه اللاعب)").fill("الإجابة قصيرة جدًا");
  await oryx.getByRole("button", { name: "ارفض" }).click();
  await expect(page.getByText("لا شيء هنا.")).toBeVisible();

  await page.getByRole("tab", { name: "تمت مراجعتها" }).click();
  await expect(items).toHaveCount(2);
  await expect(items.filter({ hasText: `@oryx_${tag}` })).toContainText("السبب: الإجابة قصيرة جدًا");
  const approved = items.filter({ hasText: `@falcon_${tag}` });
  await expect(approved).toContainText("مقبولة");
  await approved.getByLabel("سبب الإزالة (يراه اللاعب)").fill("منقولة من الإنترنت");
  await approved.getByRole("button", { name: "أزل المشاركة ونقاطها" }).click();
  await expect(items.filter({ hasText: `@falcon_${tag}` })).toContainText("أُزيلت");
  await expect(items.filter({ hasText: `@falcon_${tag}` })).toContainText(
    "السبب: منقولة من الإنترنت",
  );
});
