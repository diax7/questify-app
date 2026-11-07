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
  await expect(page.getByRole("heading", { name: "المشاركات", level: 1 })).toBeVisible();
  await expect(page.getByRole("button", { name: "بانتظار المراجعة" })).toHaveAttribute(
    "aria-pressed",
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

  await page.getByRole("button", { name: "تمت مراجعتها" }).click();
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

/**
 * "Mark these as read" is optimistic: the rows leave the list while the server is still answering, with the button
 * busy, and come back with the problem if it refuses. The auto-approved queue is answered by the test, since the
 * test server has no way to make one.
 */
test("marking auto-approved submissions as read shows at once and rolls back on a refusal", async ({
  page,
}, info) => {
  test.setTimeout(90_000);
  await openBuilder(page, info.project.name);
  const queue = /\/submissions\?filter=unseen/;
  let unseen = [seenRow("a"), seenRow("b")];
  await page.route(queue, (route) =>
    route.fulfill({ json: { submissions: unseen, nextCursor: null } }),
  );
  // The server's two answers to "seen", given by the test when it chooses; the first is a refusal, the second agrees.
  const answers: Array<(status: number) => void> = [];
  const statuses = [0, 1].map(
    (index) =>
      new Promise<number>((resolve) => {
        answers[index] = resolve;
      }),
  );
  let asks = 0;
  await page.route(/\/submissions\/seen$/, async (route) => {
    const status = (await statuses[asks++]) ?? 500;
    if (status === 204) {
      unseen = [];
      await route.fulfill({ status });
    } else {
      await route.fulfill({ status, json: { code: "internal" } });
    }
  });

  await page.goto(page.url().replace(/\/quests$/, "/submissions"));
  await page.getByRole("button", { name: "قُبلت تلقائيًا ولم تُقرأ" }).click();
  const items = page.getByTestId("submission");
  await expect(items).toHaveCount(2);

  const mark = page.getByRole("button", { name: "علّم الظاهرة كمقروءة" });
  await mark.click();
  await expect(items).toHaveCount(0);
  await expect(mark).toHaveAttribute("aria-busy", "true");
  await expect(page.getByText("لا شيء هنا.")).toBeHidden();
  answers[0]?.(503);
  await expect(items).toHaveCount(2);
  await expect(page.getByRole("alert").filter({ hasText: /\S/ })).toBeVisible();

  await mark.click();
  await expect(items).toHaveCount(0);
  answers[1]?.(204);
  await expect(page.getByText("لا شيء هنا.")).toBeVisible();
  await expect(mark).toBeHidden();
});

/** One auto-approved submission as the queue lists it. */
function seenRow(id: string) {
  return {
    id,
    questId: "q",
    questTitle: { ar: "مهمة", en: "Quest" },
    enrollmentId: "e",
    username: `sam_${id}`,
    avatar: "fox",
    text: "نص",
    points: 5,
    status: "approved",
    auto: true,
    marked: false,
    reason: null,
    reasonSystem: false,
    createdAt: "2030-11-01T10:00:00Z",
    reviewedAt: null,
    seenAt: null,
  };
}
