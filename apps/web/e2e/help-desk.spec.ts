import { expect, test } from "@playwright/test";
import { openBuilder } from "#e2e/builder.ts";
import { CONTROL_PORT } from "#e2e/paths.ts";

const API = "http://127.0.0.1:4100";

/**
 * The help desk on the dashboard (T-310), in Arabic: a player's question sent through the API shows under Open, the
 * owner replies, it moves to Closed with who answered, a second answer from another tab is refused, and the event's
 * Help desk switch is on by default.
 */
test("the owner answers a player's question, and a second answer is refused", async ({
  page,
}, info) => {
  test.setTimeout(90_000);
  await openBuilder(page, info.project.name);
  const event = page.url().replace(/\/quests$/, "");
  const eventId = event.split("/").at(-1) ?? "";
  const control = `http://127.0.0.1:${CONTROL_PORT}`;
  const live = await page.request.post(`${control}/event-status`, {
    data: { eventId, status: "live" },
  });
  expect(live.status()).toBe(204);
  const tag = `${info.project.name.slice(0, 2)}${Date.now() % 1_000_000}`;
  const player = (await (
    await page.request.post(`${control}/player-token`, {
      data: { eventId, usernames: [`help_${tag}`] },
    })
  ).json()) as { token: string };
  const sent = await page.request.post(`${API}/v1/events/${eventId}/tickets`, {
    headers: {
      authorization: `Bearer ${player.token}`,
      "idempotency-key": crypto.randomUUID(),
    },
    data: { kind: "question", text: "أين المسرح الرئيسي؟" },
  });
  expect(sent.status(), await sent.text()).toBe(201);

  await page.goto(event);
  await expect(page.getByLabel("تشغيل المساعدة في الفعالية")).toBeChecked();
  await page.getByRole("link", { name: "المساعدة (1)" }).click();
  await expect(page.getByRole("heading", { name: "المساعدة", level: 2 })).toBeVisible();
  await expect(page.getByRole("tab", { name: "مفتوحة (1)" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const tickets = page.getByTestId("ticket");
  await expect(tickets).toHaveCount(1);
  const ticket = tickets.filter({ hasText: `@help_${tag}` });
  await expect(ticket).toContainText("أين المسرح الرئيسي؟");
  await expect(ticket).toContainText("عن الفعالية");

  // A second tab holds the same open ticket, so its answer comes second.
  const other = await page.context().newPage();
  await other.goto(page.url());
  await expect(other.getByTestId("ticket")).toHaveCount(1);

  await expect(ticket.getByRole("button", { name: "أرسل الرد" })).toBeDisabled();
  await ticket.getByLabel("الرد (يراه اللاعب باسم فريق الفعالية)").fill("خلف القاعة ب");
  await ticket.getByRole("button", { name: "أرسل الرد" }).click();
  await expect(page.getByText("لا طلبات هنا.")).toBeVisible();
  await page.getByRole("tab", { name: "مغلقة (1)" }).click();
  const closed = page.getByTestId("ticket");
  await expect(closed).toContainText("خلف القاعة ب");
  await expect(closed).toContainText("تم الرد");
  await expect(closed).toContainText(/ردّ عليه quests\./);

  const late = other.getByTestId("ticket");
  other.once("dialog", (dialog) => void dialog.accept());
  await late.getByRole("button", { name: "أغلقه محلولًا دون رد" }).click();
  await expect(late.getByRole("alert")).toContainText("أجاب أحد أعضاء الفريق عن هذا الطلب.");
});
