import { expect, test } from "@playwright/test";
import { openBuilder } from "#e2e/builder.ts";
import { CONTROL_PORT } from "#e2e/paths.ts";

/**
 * Join requests (T-218) on a live event: the owner accepts one, declines one and accepts it later, and accepts the rest
 * after a confirmation (the result stays on screen with the queue empty),
 * then changes the event's access type after a confirmation naming the effect, in both languages.
 */
test("the owner decides join requests and confirms an access change", async ({
  page,
  request,
}, info) => {
  test.setTimeout(90_000);
  await openBuilder(page, info.project.name);
  const eventId = /\/events\/([0-9a-f-]{36})\/quests/.exec(page.url())?.[1];
  const tag = `${info.project.name.slice(0, 2)}${Date.now() % 1_000_000}`;
  const control = `http://127.0.0.1:${CONTROL_PORT}`;
  const seeded = await request.post(`${control}/players`, {
    data: {
      eventId,
      usernames: [`lynx_${tag}`, `hare_${tag}`, `wolf_${tag}`],
      status: "pending",
    },
  });
  expect(seeded.status()).toBe(204);
  const live = await request.post(`${control}/event-status`, { data: { eventId, status: "live" } });
  expect(live.status()).toBe(204);

  await page.goto(page.url().replace(/\/quests$/, "/players"));
  const requests = page.getByRole("region", { name: "طلبات الانضمام" });
  await expect(requests).toContainText("بانتظار القرار: 3");
  await requests.getByRole("button", { name: `اقبل @lynx_${tag}` }).click();
  await expect(requests).toContainText("بانتظار القرار: 2");
  await expect(requests.getByText(`@lynx_${tag}`)).toHaveCount(0);
  await requests.getByRole("button", { name: `ارفض @hare_${tag}` }).click();
  await expect(requests.getByRole("listitem").filter({ hasText: `@hare_${tag}` })).toContainText(
    "رُفض الطلب",
  );
  await expect(requests.getByRole("listitem").last()).toContainText(`@hare_${tag}`);
  await requests.getByRole("button", { name: `اقبل @hare_${tag}` }).click();
  await expect(requests.getByText(`@hare_${tag}`)).toHaveCount(0);
  await requests.getByRole("button", { name: "اقبل الكل" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "اقبل الكل" }).click();
  await expect(requests.getByRole("status")).toHaveText("قُبل: 1. بانتظار القرار: 0.");
  await expect(requests).toContainText("بانتظار القرار: 0");
  await expect(requests.getByRole("listitem")).toHaveCount(0);
  await expect(requests.getByRole("button", { name: "اقبل الكل" })).toHaveCount(0);

  await page.goto(
    page
      .url()
      .replace(/\/players$/, "")
      .replace("/ar/", "/en/"),
  );
  await page.getByLabel("Who can find it").selectOption("private");
  await page.getByRole("button", { name: "Save changes" }).click();
  const confirm = page.getByRole("alertdialog");
  await expect(confirm).toContainText("People with the code ask to join and you accept them.");
  await expect(confirm).toContainText("Every current player stays");
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Save changes" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Change access" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Changes saved." })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Who can find it")).toHaveValue("private");
});
