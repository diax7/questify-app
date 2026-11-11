import { expect, type Page } from "@playwright/test";
import { LAYOUT_ORGANIZER, type LayoutIds } from "#e2e/layout.ts";
import { codeFor } from "#e2e/mail.ts";
import { CONTROL_PORT } from "#e2e/paths.ts";

/**
 * The run that fills an event for the page-by-page checks (layout.spec.ts and a11y.spec.ts): a new organizer's owner
 * with one draft event and a quest, a prize desk and rewards, then the live event with a team, players, points, a
 * submission, a flagged case, an escalated ticket and an invitation request.
 */
const PASSWORD = "an organizer's own pass phrase";

const CONTROL = `http://127.0.0.1:${CONTROL_PORT}`;
const API = "http://127.0.0.1:4100";
const WEB = "http://localhost:3100";

/** One call to the test control (the server's back door for what only the platform does). */
export async function control(page: Page, path: string, data: object = {}): Promise<unknown> {
  const response = await page.request.post(`${CONTROL}${path}`, { data });
  expect(response.status(), `${path}: ${await response.text()}`).toBeLessThan(300);
  return response.status() === 204 ? undefined : response.json();
}

/** One call to the API as the signed-in owner, from the dashboard's own origin. */
export async function send(page: Page, method: "POST" | "PUT", path: string, data: object) {
  const response = await page.request.fetch(path, {
    method,
    data,
    headers: { origin: WEB, "idempotency-key": crypto.randomUUID() },
  });
  expect(response.status(), `${method} ${path}: ${await response.text()}`).toBeLessThan(300);
  return response;
}

export type Event = Readonly<{ organizerId: string; eventId: string }>;

/** A new organizer's owner with one draft event that has one quest; returns where they live. */
export async function createEvent(page: Page, project: string): Promise<Event> {
  const email = `layout.${project}.${Date.now()}.${Math.floor(Math.random() * 1e6)}@riyadh.test`;
  await page.goto("/en/sign-up");
  await page.getByLabel("Organizer name", { exact: true }).fill(LAYOUT_ORGANIZER);
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("New password", { exact: true }).fill(PASSWORD);
  await page.getByLabel("Type the new password again", { exact: true }).fill(PASSWORD);
  await page.getByLabel("I accept the organizer terms").check();
  await page.getByLabel("I accept the data processing agreement").check();
  await page.getByLabel("I accept the content rules").check();
  await page.getByRole("button", { name: "Create the account" }).click();
  await page.getByRole("textbox", { name: "Sign-in code" }).fill(await codeFor(email));
  await page.getByRole("button", { name: "Create the account" }).click();
  await expect(page).toHaveURL(/\/en$/);

  await page.getByRole("link", { name: "Events" }).click();
  await page.getByRole("link", { name: "New event" }).click();
  await page.getByLabel("Name in Arabic", { exact: true }).fill("مهرجان التخطيط");
  await page.getByLabel("Name in English", { exact: true }).fill("Layout Fest");
  await page.getByLabel("Starts", { exact: true }).fill("2030-11-01T09:00");
  await page.getByLabel("Ends", { exact: true }).fill("2030-11-01T17:00");
  await page.getByRole("button", { name: "Create event" }).click();
  await expect(page.getByRole("button", { name: "Save changes" })).toBeVisible();
  const match = /\/organizers\/([^/]+)\/events\/([^/?#]+)/.exec(page.url());
  const ids = { organizerId: match?.[1] ?? "", eventId: match?.[2] ?? "" };

  await page.goto(`/en/organizers/${ids.organizerId}/events/${ids.eventId}/quests`);
  await page.getByRole("button", { name: "Add quest" }).first().click();
  await page.getByLabel("Title in Arabic", { exact: true }).fill("ابحث عن المسرح");
  await page.getByLabel("Title in English", { exact: true }).fill("Find the stage");
  await page.getByRole("button", { name: "Add the quest" }).click();
  await expect(page.getByText("Find the stage", { exact: true })).toBeVisible();
  return ids;
}

/** An item reward picked up at the prize desk. */
const rewardBody = (nameEn: string, nameAr: string, price: number, stock: number) => ({
  kind: "item",
  name: { ar: nameAr, en: nameEn },
  description: { ar: "", en: "" },
  price,
  stock,
  perPlayerLimit: null,
  opensAt: null,
  closesAt: null,
  section: null,
  tags: { new: true, limited: false },
});

/** The prize desk, two rewards that are picked up there, and a rank prize, through the API the forms use. */
export async function fillShop(page: Page, ids: Event): Promise<void> {
  const base = `/v1/organizers/${ids.organizerId}/events/${ids.eventId}`;
  await send(page, "PUT", `${base}/shop`, {
    desk: { location: { ar: "القاعة ب", en: "Hall B" }, pin: null, hours: null },
    handoverConfirm: "collect_first",
  });
  await send(page, "POST", `${base}/rewards`, rewardBody("Event hoodie", "هودي الفعالية", 250, 3));
  await send(page, "POST", `${base}/rewards`, rewardBody("Coffee voucher", "قسيمة قهوة", 80, 40));
  await send(page, "PUT", `${base}/rank-prizes`, { rankPrizes: true });
  await send(page, "POST", `${base}/rank-prizes`, {
    kind: "item",
    rankFrom: 1,
    rankTo: 3,
    name: { ar: "سماعات", en: "Headphones" },
    description: { ar: "للثلاثة الأوائل", en: "For the first three" },
  });
}

/** Starts the event and fills it with a team, players, points, a submission, a flagged case, tickets and a request. */
export async function startAndFill(page: Page, ids: Event): Promise<LayoutIds> {
  const { eventId, organizerId } = ids;
  const base = `/v1/organizers/${organizerId}/events/${eventId}`;
  const tag = `${Date.now() % 1_000_000}`;
  // Still a draft: the owner asks for activation, so the console's queue holds a card for the run's event (the console
  // home waits for it). The request stays pending when the event is then moved to live below.
  await send(page, "POST", `${base}/activation`, {});
  await control(page, "/event-status", { eventId, status: "live" });
  await control(page, "/team", {
    eventId,
    emails: [1, 2, 3].map((n) => `editor${n}.${tag}@riyadh.test`),
  });
  await send(page, "POST", `/v1/organizers/${organizerId}/invites`, {
    email: `invited.${tag}@riyadh.test`,
    lang: "en",
  });
  await control(page, "/players", {
    eventId,
    usernames: ["sara_" + tag, "khalid_" + tag, "noura_" + tag],
  });
  await control(page, "/players", {
    eventId,
    usernames: ["waiting_" + tag, "later_" + tag],
    status: "pending",
  });
  await control(page, "/scored", {
    eventId,
    usernames: ["lina_" + tag, "omar_" + tag, "huda_" + tag],
    points: [900, 640, 410],
  });
  await control(page, "/submitted", {
    eventId,
    usernames: ["maha_" + tag, "yazan_" + tag],
    texts: ["A photo of the lion statue", "صورة عند بوابة المسرح"],
  });
  await control(page, "/flagged", { eventId, usernames: ["rami_" + tag] });

  const player = (await control(page, "/player-token", {
    eventId,
    usernames: ["help_" + tag],
  })) as { token: string };
  // The console player page waits for its "no points yet" line (layout.ts, `console-player`): the run's player must
  // hold none, so a seed that ever grants this player points fails here and not as a missing marker.
  const activity = await page.request.get(`${API}/v1/events/${eventId}/activity`, {
    headers: { authorization: `Bearer ${player.token}` },
  });
  expect(activity.status(), await activity.text()).toBe(200);
  expect(
    ((await activity.json()) as { entries: unknown[] }).entries,
    "the run's help_* player holds no points (the console-player marker is the empty ledger line)",
  ).toEqual([]);
  const asked = await page.request.post(`${API}/v1/events/${eventId}/tickets`, {
    headers: { authorization: `Bearer ${player.token}`, "idempotency-key": crypto.randomUUID() },
    data: { kind: "question", text: "Where do I pick up my prize?" },
  });
  expect(asked.status(), await asked.text()).toBe(201);
  const ticketId = ((await asked.json()) as { ticket: { id: string } }).ticket.id;
  await send(page, "POST", `${base}/tickets/${ticketId}/escalate`, {
    note: "Asked the prize desk",
  });

  await control(page, "/make-admin", { eventId });
  await control(page, "/invitations-switch");
  // Also what puts the event on the console's readiness list: scheduled, starting tomorrow, ending in ten days.
  await control(page, "/invitation-event", { eventId, days: 10 });
  const soon = await page.request.get("/v1/admin/readiness");
  expect(soon.status(), await soon.text()).toBe(200);
  const listed = ((await soon.json()) as { events: { id: string }[] }).events;
  expect(
    listed.some((one) => one.id === eventId),
    "the run's event is on the readiness list (a draft or scheduled event that starts within 14 days)",
  ).toBe(true);
  await send(page, "POST", `${base}/invitation-campaigns`, {
    cityId: null,
    interests: [],
    history: "none",
    size: 500,
    sendAfter: null,
  });
  const campaigns = await page.request.get(`${base}/invitation-campaigns`);
  const campaignId = ((await campaigns.json()) as { campaigns: { id: string }[] }).campaigns[0]?.id;
  const event = await page.request.get(base);
  const joinCode = ((await event.json()) as { event: { joinCode: string } }).event.joinCode;
  const found = await send(page, "POST", "/v1/admin/players/search", {
    by: "username",
    q: "help_" + tag,
  });
  const playerId = ((await found.json()) as { players: { id: string }[] }).players[0]?.id ?? "";
  return { organizerId, eventId, joinCode, ticketId, campaignId: campaignId ?? "", playerId };
}
