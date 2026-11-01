import { expect, test, type APIRequestContext } from "@playwright/test";
import { openBuilder } from "#e2e/builder.ts";
import { openMenu } from "#e2e/nav.ts";
import { CONTROL_PORT } from "#e2e/paths.ts";

const API = "http://127.0.0.1:4100";
const CONTROL = `http://127.0.0.1:${CONTROL_PORT}`;

type Sent = Readonly<{ kind: string; text: string; reportedUsername?: string }>;

const prize = (n: number): Sent => ({ kind: "prize", text: `الجائزة ${n} لم تصل` });

/** A player of the event with a token of their own, who sends these requests through the API. */
async function asksAs(
  request: APIRequestContext,
  eventId: string,
  username: string,
  sent: readonly Sent[],
): Promise<void> {
  const made = await request.post(`${CONTROL}/player-token`, {
    data: { eventId, usernames: [username] },
  });
  const { token } = (await made.json()) as { token: string };
  for (const body of sent) {
    const answer = await request.post(`${API}/v1/events/${eventId}/tickets`, {
      headers: { authorization: `Bearer ${token}`, "idempotency-key": crypto.randomUUID() },
      data: body,
    });
    expect(answer.status(), await answer.text()).toBe(201);
  }
}

/**
 * The owner's Inbox (T-616), in Arabic: the counts by kind match the Help desk's list for the same kind, each count
 * opens that list, the reported players and the prize problems show their oldest requests with "View more" past five,
 * and the join requests are accepted all at once from the same page; the English heading.
 */
test("the Inbox counts what waits and opens the list each count stands for", async ({
  page,
  request,
}, info) => {
  test.setTimeout(120_000);
  await openBuilder(page, info.project.name);
  const eventUrl = page.url().replace(/\/quests$/, "");
  const eventId = /\/events\/([0-9a-f-]{36})$/.exec(eventUrl)?.[1] ?? "";
  const tag = `${info.project.name.slice(0, 2)}${Date.now() % 1_000_000}`;
  const live = await request.post(`${CONTROL}/event-status`, { data: { eventId, status: "live" } });
  expect(live.status()).toBe(204);
  const members = await request.post(`${CONTROL}/players`, {
    data: { eventId, usernames: [`target_${tag}`] },
  });
  expect(members.status()).toBe(204);
  const asking = await request.post(`${CONTROL}/players`, {
    data: { eventId, usernames: [`lynx_${tag}`, `hare_${tag}`], status: "pending" },
  });
  expect(asking.status()).toBe(204);

  await asksAs(request, eventId, `ask1_${tag}`, [prize(1), prize(2), prize(3)]);
  await asksAs(request, eventId, `ask2_${tag}`, [prize(4), prize(5), prize(6)]);
  await asksAs(request, eventId, `ask3_${tag}`, [
    { kind: "report_player", text: "يسيء للآخرين", reportedUsername: `target_${tag}` },
    { kind: "question", text: "أين المسرح؟" },
  ]);

  await page.goto(eventUrl);
  await openMenu(page);
  await page.getByRole("link", { name: "الوارد", exact: true }).click();
  await expect(page.getByRole("heading", { name: "الوارد", level: 1 })).toBeVisible();

  await expect(page.getByRole("link", { name: "افتح مشكلات الجوائز: 6" })).toBeVisible();
  await expect(page.getByRole("link", { name: "افتح بلاغات عن لاعبين: 1" })).toBeVisible();
  await expect(page.getByRole("link", { name: "افتح أسئلة: 1" })).toBeVisible();
  await expect(page.getByRole("link", { name: "افتح مشكلات: 0" })).toBeVisible();
  await expect(page.getByRole("link", { name: "افتح طلبات الانضمام: 2" })).toBeVisible();

  const reports = page.getByRole("region", { name: "اللاعبون المُبلَّغ عنهم" });
  await expect(reports.getByRole("listitem")).toHaveCount(1);
  await expect(reports).toContainText(`البلاغ عن: @target_${tag}`);
  await expect(reports.getByRole("link", { name: /^عرض المزيد/ })).toHaveCount(0);

  const oldest = page.getByRole("region", { name: "أقدم مشكلات الجوائز" });
  await expect(oldest.getByRole("listitem")).toHaveCount(5);
  await expect(oldest).toContainText("الجائزة 1 لم تصل");
  await expect(oldest).not.toContainText("الجائزة 6 لم تصل");

  // A count opens the Help desk on the same list, and the list holds exactly what the count said.
  await oldest.getByRole("link", { name: /^عرض المزيد/ }).click();
  await expect(page.getByRole("heading", { name: "المساعدة", level: 1 })).toBeVisible();
  await expect(page.getByLabel("النوع")).toHaveValue("prize");
  await expect(page.getByTestId("ticket")).toHaveCount(6);

  await page.goto(`${eventUrl}/inbox`);
  await page.getByRole("link", { name: "افتح بلاغات عن لاعبين: 1" }).click();
  await expect(page.getByLabel("النوع")).toHaveValue("report_player");
  await expect(page.getByTestId("ticket")).toHaveCount(1);

  // The join requests are decided from the Inbox, and the count follows.
  await page.goto(`${eventUrl}/inbox`);
  const requests = page.locator("section[aria-labelledby='requests-title']");
  await expect(requests.getByRole("listitem")).toHaveCount(2);
  await requests.getByRole("button", { name: "اقبل الكل" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "اقبل الكل" }).click();
  await expect(requests.getByRole("status")).toContainText("قُبل: 2");
  await expect(page.getByRole("link", { name: "افتح طلبات الانضمام: 0" })).toBeVisible();
  await expect(requests.getByRole("listitem")).toHaveCount(0);
  await expect(requests.getByText("لا شيء بانتظارك.")).toBeVisible();

  await page.goto(`${eventUrl.replace("/ar/", "/en/")}/inbox`);
  await expect(page.getByRole("heading", { name: "Inbox", level: 1 })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open Prize problems: 6" })).toBeVisible();
});

test("the Inbox says nothing is waiting for a quiet event, and the Help desk opens on its first tab", async ({
  page,
}, info) => {
  test.setTimeout(60_000);
  await openBuilder(page, info.project.name);
  const eventUrl = page.url().replace(/\/quests$/, "");
  await page.goto(`${eventUrl}/inbox`);
  await expect(page.getByRole("heading", { name: "الوارد", level: 1 })).toBeVisible();
  await expect(page.getByRole("link", { name: "افتح مشكلات الجوائز: 0" })).toBeVisible();
  const reports = page.getByRole("region", { name: "اللاعبون المُبلَّغ عنهم" });
  await expect(reports.getByText("لا شيء بانتظارك.")).toBeVisible();
  await expect(page.locator("section[aria-labelledby='requests-title']")).toHaveCount(0);

  await page.goto(`${eventUrl}/help?status=closed&kind=nonsense`);
  await expect(page.getByRole("button", { name: /^مغلقة/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByLabel("النوع")).toHaveValue("");
});
