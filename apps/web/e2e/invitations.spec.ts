import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";
import { openBuilder } from "#e2e/builder.ts";
import { account, freshAddress, signIn } from "#e2e/mail.ts";
import { CONTROL_PORT } from "#e2e/paths.ts";
import { openMenu } from "#e2e/nav.ts";

const CONTROL = `http://127.0.0.1:${CONTROL_PORT}`;

/**
 * Questify invitations on the web (T-409b, FR-738, FR-739): the owner's Invitations page, the console's queue and
 * detail, and the landing page of an invitation link. The sender tick is off in the e2e API, so the parts of a
 * campaign's life that it would write (started, a recipient's link, the published counts) come from the test control.
 * One browser session holds the owner and the admin (`make-admin`), as the console specs do.
 */

/** The page's own error line (Next's route announcer is a second alert on every page). */
const alert = (page: Page): Locator => page.locator('p[role="alert"]');

async function expectNoSidewaysScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

async function control(page: Page, path: string, data: object = {}): Promise<unknown> {
  const response = await page.request.post(`${CONTROL}${path}`, { data });
  expect(response.status(), path).toBeLessThan(300);
  return response.status() === 204 ? undefined : response.json();
}

type Scene = Readonly<{ organizerId: string; eventId: string }>;

/**
 * A new organizer and its event, scheduled to end in 10 days (so a send time days away is allowed), the invitation
 * switch on, and the owner made an admin too.
 */
async function setUp(page: Page, project: string): Promise<Scene> {
  await openBuilder(page, project);
  const ids = /organizers\/([^/]+)\/events\/([^/]+)/.exec(new URL(page.url()).pathname);
  const scene = { organizerId: ids?.[1] ?? "", eventId: ids?.[2] ?? "" };
  await control(page, "/make-admin", { eventId: scene.eventId });
  await control(page, "/invitations-switch");
  await control(page, "/invitation-event", { eventId: scene.eventId, days: 10 });
  page.on("dialog", (dialog) => void dialog.accept());
  return scene;
}

/** The id of the event's newest request, read the way the dashboard does. */
async function newestCampaign(page: Page, scene: Scene): Promise<string> {
  const response = await page.request.get(
    `/v1/organizers/${scene.organizerId}/events/${scene.eventId}/invitation-campaigns`,
  );
  const body = (await response.json()) as { campaigns: { id: string }[] };
  return body.campaigns[0]?.id ?? "";
}

/** A Riyadh wall-clock time `days` from today at `hour`, in the form a date-time field takes. */
function riyadhLocal(days: number, hour: number): string {
  const day = new Date(Date.now() + 3 * 3_600_000 + days * 86_400_000);
  return `${day.toISOString().slice(0, 10)}T${String(hour).padStart(2, "0")}:00`;
}

/** Opens an invitation link as a stranger (no account, no cookies) and answers the page and its open calls. */
async function openLinkAsStranger(
  browser: Browser,
  address: string,
): Promise<{ page: Page; opens: () => number; close: () => Promise<void> }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  let opens = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/v1/public/invitation-open") opens += 1;
  });
  await page.goto(address);
  return { page, opens: () => opens, close: () => context.close() };
}

test("in English an owner asks, the admin approves the frozen text, the counts stay rounded and the link counts once", async ({
  page,
  browser,
}, info) => {
  test.setTimeout(240_000);
  const scene = await setUp(page, info.project.name);
  const asked: string[] = [];
  page.on("dialog", (dialog) => asked.push(dialog.message()));
  const dashboard = `/en/organizers/${scene.organizerId}/events/${scene.eventId}/invitations`;

  // The event page links to the page while the switch is on.
  await page.goto(`/en/organizers/${scene.organizerId}/events/${scene.eventId}`);
  await openMenu(page);
  await page.getByRole("link", { name: "Invitations", exact: true }).click();
  await expect(page).toHaveURL(dashboard);
  await expect(page.getByRole("heading", { name: "Invitations", level: 1 })).toBeVisible();
  await expect(
    page.getByText(
      "Nothing is charged here: the Questify team contacts you about the price before approving.",
    ),
  ).toBeVisible();
  await expect(page.getByText("No requests yet.")).toBeVisible();

  // A name the SMS cannot carry is refused with the reason, and the size is checked before anything is sent.
  await control(page, "/invitation-event", { eventId: scene.eventId, nameAr: "اتصل 0501234567" });
  await page.getByLabel("Number of invitations").fill("50");
  await page.getByRole("button", { name: "Send the request" }).click();
  await expect(alert(page)).toContainText(
    "The event's Arabic name can't go in a text message: it looks like a phone number. Change the name, then ask again.",
  );
  await control(page, "/invitation-event", { eventId: scene.eventId, nameAr: "ملتقى نجد" });
  await page.getByLabel("Number of invitations").fill("49");
  await page.getByRole("button", { name: "Send the request" }).click();
  await expect(alert(page)).toHaveText("Enter a whole number from 50 to 100,000.");

  // The request is made; the form gives way to the card and the "one open request" note.
  await page.getByLabel("Number of invitations").fill("50");
  await page.getByLabel("City").selectOption("sa-riyadh");
  await page.getByLabel("Technology").check();
  await page.getByLabel("Music").check();
  await page.getByLabel("Past events").selectOption("own");
  await page.getByRole("button", { name: "Send the request" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Request sent." })).toHaveText(
    "Request sent. The Questify team will contact you about the price.",
  );
  const card = page.getByTestId("invitation");
  await expect(card.getByText("Waiting for approval")).toBeVisible();
  await expect(card).toContainText("Invitations asked for: 50");
  await expect(card).toContainText("Players who joined another of your events");
  await expect(card).toContainText("City: Riyadh");
  await expect(card).toContainText("Interests: Music, Technology");
  await expect(page.getByText("This event already has an open request.")).toBeVisible();
  await expect(page.getByRole("form", { name: "Ask for invitations" })).toHaveCount(0);
  await expectNoSidewaysScroll(page);
  const campaignId = await newestCampaign(page, scene);

  // The console lists it and opens it: the names, the exact text and the audience now.
  await page.goto("/en/console");
  await openMenu(page);
  await expect(page.getByRole("link", { name: /^Invitations/ })).toBeVisible();
  await page.goto("/en/console/invitations");
  await expect(page.getByRole("heading", { name: "Invitations", level: 1 })).toBeVisible();
  await page.locator(`a[href$="/console/invitations/${campaignId}"]`).click();
  await expect(page.getByRole("heading", { name: "Invitation request", level: 1 })).toBeVisible();
  await expect(page.getByTestId("detail-state")).toHaveText("Waiting for approval");
  await expect(page.getByTestId("estimate")).toHaveText(/^Players matching now: \d+$/);
  await expect(page.getByTestId("name-ar")).toContainText("ملتقى نجد");
  await expect(page.getByTestId("name-en")).toContainText("No name in this language");
  await expect(page.getByRole("heading", { name: "The text players will get" })).toBeVisible();
  await expect(page.getByTestId("message-text-ar")).toHaveText(
    /^دعوة إلى ملتقى نجد: https:\/\/\S+\/ar\/i#\S{22}\nإيقاف العروض: \S+$/,
  );
  await expect(page.getByTestId("message-text-en")).toHaveText(
    /^Invitation to ملتقى نجد: https:\/\/\S+\/en\/i#\S{22}\nStop offers: \S+$/,
  );
  await expectNoSidewaysScroll(page);

  // The owner renames the event before the admin clicks Approve: the API refuses, and the page shows the new text.
  await page.getByLabel("Send time (Riyadh time)", { exact: true }).fill(riyadhLocal(3, 23));
  await page
    .getByLabel("Note for the organizer (optional)", { exact: true })
    .fill("Agreed by phone");
  await control(page, "/invitation-event", { eventId: scene.eventId, nameAr: "ملتقى الرياض" });
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(alert(page)).toHaveText(
    "The event was renamed after you opened this page. Read the new text, then approve again.",
  );
  await expect(page.getByTestId("message-text-ar")).toContainText("دعوة إلى ملتقى الرياض: ");

  // Approved: a send time in quiet hours moved to the morning, and the text is frozen.
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  const moved = page.getByRole("status").filter({ hasText: "Approved." });
  await expect(moved).toContainText("The send time moved to");
  await expect(moved).toContainText("09:00");
  await expect(moved).toContainText("to stay out of quiet hours.");
  await expect(page.getByTestId("detail-state")).toHaveText("Approved");
  await expect(page.getByTestId("approved-line")).toContainText(
    "Approved: up to 50 messages, sending from",
  );
  await expect(page.getByRole("heading", { name: "The approved text" })).toBeVisible();
  await expect(page.getByText("This text is frozen")).toBeVisible();
  await expect(page.getByRole("form", { name: "Approve the request" })).toHaveCount(0);
  await control(page, "/invitation-event", { eventId: scene.eventId, nameAr: "اسم آخر" });
  await page.reload();
  await expect(page.getByTestId("name-ar")).toContainText("اسم آخر");
  await expect(page.getByTestId("message-text-ar")).toContainText("دعوة إلى ملتقى الرياض: ");
  await expect(page.getByTestId("approved-names")).toContainText("ملتقى الرياض");
  // Approve asked first, each time, with the cap and the time asked for.
  expect(asked).toHaveLength(2);
  for (const question of asked) {
    expect(question).toMatch(/^Send up to 50 messages from .*(Riyadh time)?$/);
  }
  // A name the rule would refuse today changes nothing for an approved request: no warning beside a frozen text.
  await control(page, "/invitation-event", { eventId: scene.eventId, nameAr: "اتصل 0501234567" });
  await page.reload();
  await expect(page.getByTestId("message-text-ar")).toContainText("دعوة إلى ملتقى الرياض: ");
  await expect(page.getByText("can't go in a text message")).toHaveCount(0);
  await control(page, "/invitation-event", { eventId: scene.eventId, nameAr: "اسم آخر" });

  // The owner sees the state, the note and no counts; once sending has started, only rounded ones.
  await page.goto(dashboard);
  await expect(card.getByText("Approved", { exact: true })).toBeVisible();
  await expect(card).toContainText("Approved: up to 50 messages, sending from");
  await expect(card).toContainText("Note from Questify: Agreed by phone");
  await expect(page.getByTestId("invitation-counts")).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Withdraw the request" })).toBeVisible();
  await control(page, "/invitation-started", { campaignId, sent: 1277, opened: 7, joined: 34 });
  await page.reload();
  await expect(card.getByText("Sending", { exact: true })).toBeVisible();
  await expect(page.getByTestId("count-sent")).toHaveText("1,270+");
  await expect(page.getByTestId("count-opened")).toHaveText("Fewer than 10");
  await expect(page.getByTestId("count-joined")).toHaveText("30+");
  await expect(page.getByText("Counts as of")).toBeVisible();
  await expect(page.locator("body")).not.toContainText("1,277");
  await expect(page.locator("body")).not.toContainText("1277");
  await expect(card.getByRole("button", { name: "Withdraw the request" })).toHaveCount(0);

  // The link counts one open, however many times it is opened; the page shows the event and removes the token.
  const { token } = (await control(page, "/invitation-link", { campaignId })) as { token: string };
  const first = await openLinkAsStranger(browser, `/en/i#${token}`);
  await expect(first.page.getByTestId("invitation-event")).toHaveText("اسم آخر");
  await expect(first.page.getByText("You're invited to an event on Questify")).toBeVisible();
  await expect(first.page.getByRole("link", { name: "Open in Questify" })).toHaveAttribute(
    "href",
    /^\/en\/e\/[A-Za-z0-9]+$/,
  );
  expect(first.page.url()).not.toContain("#");
  expect(first.opens()).toBe(1);
  await expectNoSidewaysScroll(first.page);
  await first.close();
  const second = await openLinkAsStranger(browser, `/ar/i#${token}`);
  await expect(second.page.getByTestId("invitation-event")).toHaveText("اسم آخر");
  await expect(second.page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(second.page.getByText("دعوة إلى فعالية على Questify")).toBeVisible();
  await expect(second.page.getByRole("link", { name: "افتح في Questify" })).toHaveAttribute(
    "href",
    /^\/ar\/e\/[A-Za-z0-9]+$/,
  );
  await expectNoSidewaysScroll(second.page);
  await second.close();
  await page.goto(`/en/console/invitations/${campaignId}`);
  await expect(page.getByTestId("counter-sent")).toHaveText("1,277");
  await expect(page.getByTestId("counter-opened")).toHaveText("1");

  // A link that is not ours, or has no token, says so and shows nothing.
  const unknown = await openLinkAsStranger(browser, "/en/i#AAAAAAAAAAAAAAAAAAAAAA");
  await expect(alert(unknown.page)).toHaveText("This invitation has ended.");
  await unknown.close();
  const bare = await openLinkAsStranger(browser, "/en/i");
  await expect(alert(bare.page)).toHaveText(
    "This link is incomplete. Open the link from your message again.",
  );
  expect(bare.opens()).toBe(0);
  await bare.close();

  // The admin cancels with a note; the page says so and offers nothing more.
  const cancel = page.getByRole("button", { name: "Cancel the request" });
  await expect(cancel).toBeDisabled();
  await page
    .getByLabel("Note for the organizer (required to refuse or cancel)")
    .fill("Stopped at the organizer's request");
  await cancel.click();
  await expect(page.getByRole("status").filter({ hasText: "Cancelled." })).toBeVisible();
  await expect(page.getByTestId("detail-state")).toHaveText("Cancelled");
  await expect(page.getByRole("button", { name: "Cancel the request" })).toHaveCount(0);
});

test("in Arabic an owner asks and withdraws, the admin refuses with a note, and the pages read right to left", async ({
  page,
}, info) => {
  test.setTimeout(180_000);
  const scene = await setUp(page, info.project.name);
  const asked: string[] = [];
  page.on("dialog", (dialog) => asked.push(dialog.message()));
  await page.goto(`/ar/organizers/${scene.organizerId}/events/${scene.eventId}/invitations`);
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByRole("heading", { name: "الدعوات", level: 1 })).toBeVisible();
  await expect(
    page.getByText("لا يُدفع شيء هنا. يتواصل معك فريق Questify بشأن السعر قبل اعتماد الطلب."),
  ).toBeVisible();
  await expect(page.getByText("لا طلبات بعد.")).toBeVisible();
  await expectNoSidewaysScroll(page);

  // Ask, then withdraw (after a confirmation).
  await page.getByLabel("عدد الدعوات").fill("50");
  await page.getByRole("button", { name: "أرسل الطلب" }).click();
  await expect(page.getByRole("status")).toHaveText(
    "أُرسل الطلب. سيتواصل معك فريق Questify بشأن السعر.",
  );
  const card = page.getByTestId("invitation");
  await expect(card.getByText("بانتظار الاعتماد")).toBeVisible();
  await expect(card).toContainText("عدد الدعوات المطلوب: 50");
  await expectNoSidewaysScroll(page);
  await card.getByRole("button", { name: "اسحب الطلب" }).click();
  await expect(card.getByText("ملغى", { exact: true })).toBeVisible();
  await expect(card).toContainText("سُحب الطلب.");

  // Ask again; the admin finds it in the queue and refuses it with a note the owner reads.
  await page.getByLabel("عدد الدعوات").fill("60");
  await page.getByRole("button", { name: "أرسل الطلب" }).click();
  await expect(page.getByTestId("invitation").first().getByText("بانتظار الاعتماد")).toBeVisible();
  const campaignId = await newestCampaign(page, scene);
  await page.goto("/ar/console/invitations");
  await expect(page.getByRole("heading", { name: "الدعوات", level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "طلبات مفتوحة" })).toBeVisible();
  await expectNoSidewaysScroll(page);
  await page.locator(`a[href$="/console/invitations/${campaignId}"]`).click();
  await expect(page.getByRole("heading", { name: "طلب دعوات", level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "النص الذي سيصل اللاعبين" })).toBeVisible();
  await expect(page.getByTestId("message-text-ar")).toContainText("دعوة إلى ملتقى نجد: ");
  await expect(page.getByTestId("estimate")).toContainText("اللاعبون المطابقون الآن: ");
  await expectNoSidewaysScroll(page);
  const refuse = page.getByRole("button", { name: "ارفض الطلب" });
  await expect(refuse).toBeDisabled();
  await page.getByLabel("ملاحظة للمنظّم (مطلوبة للرفض أو الإلغاء)").fill("السعر غير متفق عليه");
  await refuse.click();
  await expect(page.getByRole("status")).toHaveText("رُفض الطلب. يرى المنظّم ملاحظتك.");
  await expect(page.getByTestId("detail-state")).toHaveText("مرفوض");
  expect(asked.at(-1)).toBe("رفض الطلب؟ يرى المنظّم ملاحظتك ولا يمكن التراجع.");
  await page.goto(`/ar/organizers/${scene.organizerId}/events/${scene.eventId}/invitations`);
  const refused = page.locator('[data-testid="invitation"][data-state="refused"]');
  await expect(refused).toContainText("مرفوض");
  await expect(refused).toContainText("ملاحظة من Questify: السعر غير متفق عليه");

  // The landing page, without a token, reads right to left too.
  await page.goto("/ar/i");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(alert(page)).toHaveText("الرابط ناقص. افتح الرابط من الرسالة مرة أخرى.");
  await expectNoSidewaysScroll(page);
});

test("an editor reads the page but cannot ask or withdraw", async ({ page }, info) => {
  test.setTimeout(120_000);
  await freshAddress(page);
  await signIn(page, account("invite", info));
  await control(page, "/invitations-switch");
  await page.getByRole("link", { name: "Events" }).click();
  await page.getByRole("link", { name: "Tech Fest" }).click();
  await expect(page).toHaveURL(/\/events\/[0-9a-f-]{36}$/);
  await openMenu(page);
  await page.getByRole("link", { name: "Invitations", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Invitations", level: 1 })).toBeVisible();
  await expect(
    page.getByText("Only the owner can ask for invitations or withdraw a request."),
  ).toBeVisible();
  await expect(page.getByRole("form", { name: "Ask for invitations" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Withdraw/ })).toHaveCount(0);
});

test("an organizer who is not a Questify admin does not find the console pages", async ({
  page,
}, info) => {
  await openBuilder(page, info.project.name);
  expect((await page.goto("/ar/console/invitations"))?.status()).toBe(404);
  const missing = await page.goto("/ar/console/invitations/44444444-4444-4444-8444-444444444444");
  expect(missing?.status()).toBe(404);
});
