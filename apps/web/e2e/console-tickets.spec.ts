import { expect, test } from "@playwright/test";
import { openBuilder } from "#e2e/builder.ts";
import { openMenu } from "#e2e/nav.ts";
import { CONTROL_PORT } from "#e2e/paths.ts";

const API = "http://127.0.0.1:4100";

/**
 * Escalation and Questify's queue (T-312), in Arabic: the owner escalates a player's question with a note, it waits
 * under With Questify read-only, a Questify admin answers it from the console's Tickets, and the dashboard's Closed
 * tab says the Questify team answered. A ticket never escalated, typed into the console's URL, is not found.
 */
test("an escalated ticket reaches the console, Questify answers, the dashboard shows it", async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  await openBuilder(page, info.project.name);
  const event = page.url().replace(/\/quests$/, "");
  const eventId = event.split("/").at(-1) ?? "";
  const control = `http://127.0.0.1:${CONTROL_PORT}`;
  expect(
    (
      await page.request.post(`${control}/event-status`, { data: { eventId, status: "live" } })
    ).status(),
  ).toBe(204);
  const tag = `${info.project.name.slice(0, 2)}${Date.now() % 1_000_000}`;
  const player = (await (
    await page.request.post(`${control}/player-token`, {
      data: { eventId, usernames: [`esc_${tag}`] },
    })
  ).json()) as { token: string };
  const send = async (text: string) => {
    const sent = await page.request.post(`${API}/v1/events/${eventId}/tickets`, {
      headers: { authorization: `Bearer ${player.token}`, "idempotency-key": crypto.randomUUID() },
      data: { kind: "question", text },
    });
    expect(sent.status(), await sent.text()).toBe(201);
    return ((await sent.json()) as { ticket: { id: string } }).ticket.id;
  };
  await send("أين أستلم جائزتي؟");
  const never = await send("سؤال آخر");

  await page.goto(`${event}/help`);
  const tickets = page.getByTestId("ticket");
  await expect(tickets).toHaveCount(2);
  const first = tickets.filter({ hasText: "أين أستلم جائزتي؟" });
  await first.getByRole("button", { name: "أحِله إلى كويستفاي" }).click();
  await first
    .getByLabel("ماذا جرّبتم؟ يقرأ هذا فريق كويستفاي، ولا يراه اللاعب")
    .fill("سألنا مكتب الجوائز");
  page.once("dialog", (dialog) => void dialog.accept());
  await first.getByRole("button", { name: "أحِل الطلب" }).click();
  await expect(page.getByRole("button", { name: "لدى كويستفاي (1)" })).toBeVisible();
  await page.getByRole("button", { name: "لدى كويستفاي (1)" }).click();
  const waiting = page.getByTestId("ticket");
  await expect(waiting).toHaveCount(1);
  await expect(waiting).toContainText("ملاحظتكم لكويستفاي: سألنا مكتب الجوائز");
  await expect(waiting.getByRole("button", { name: "أرسل الرد" })).toHaveCount(0);

  expect((await page.request.post(`${control}/make-admin`, { data: { eventId } })).status()).toBe(
    204,
  );
  await page.goto("/ar/console");
  await openMenu(page);
  await page.getByRole("link", { name: /^التذاكر/ }).click();
  await expect(page.getByRole("heading", { name: "التذاكر", level: 1 })).toBeVisible();
  const row = page.getByTestId("console-ticket").filter({ hasText: "أين أستلم جائزتي؟" });
  await expect(row).toContainText("محالة");
  await row.getByRole("link", { name: "أين أستلم جائزتي؟" }).click();
  await expect(page.getByText("ملاحظة فريق الفعالية: سألنا مكتب الجوائز")).toBeVisible();
  await page.getByLabel("الرد (يراه اللاعب باسم فريق كويستفاي)").fill("من البوابة 3");
  await page.getByRole("button", { name: "أرسل الرد" }).click();
  await expect(page.getByText("ردّ عليه فريق كويستفاي")).toBeVisible();

  await page.goto(`/ar/console/tickets/${never}`);
  await expect(page.getByText("لم نجد هذه التذكرة.")).toBeVisible();

  await page.goto(`${event}/help`);
  await page.getByRole("button", { name: "مغلقة (1)" }).click();
  const closed = page.getByTestId("ticket");
  await expect(closed).toContainText("من البوابة 3");
  await expect(closed).toContainText("ردّ عليه فريق كويستفاي");

  const mine = await page.request.get(`${API}/v1/me/tickets`, {
    headers: { authorization: `Bearer ${player.token}` },
  });
  const answered = (
    (await mine.json()) as { tickets: { reply: string | null; answeredBy: string | null }[] }
  ).tickets.find((ticket) => ticket.reply === "من البوابة 3");
  expect(answered?.answeredBy).toBe("questify");
});
