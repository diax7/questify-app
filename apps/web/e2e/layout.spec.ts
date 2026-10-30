import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  LAYOUT_PAGES,
  PUBLIC_PAGES,
  expectCleanLayout,
  expectNavFits,
  expectStateContrast,
  waitUntilSettled,
  watchRequests,
  type LayoutIds,
  type LayoutPage,
} from "#e2e/layout.ts";
import { codeFor, freshAddress } from "#e2e/mail.ts";
import { openMenu } from "#e2e/nav.ts";
import { CONTROL_PORT } from "#e2e/paths.ts";

/**
 * The layout check (ADR-364, T-599, T-599b): every page listed in `LAYOUT_PAGES` and `PUBLIC_PAGES`, in English and
 * Arabic, at 1440 wide on the desktop project and 360 on the phone project (FR-1746), with no sideways scrolling, no
 * controls or lines of text on top of each other and no text under 14px. The event is filled first (a prize desk,
 * rewards, a rank prize, a team, players with points, a submission, a flagged case, an escalated ticket, an invitation
 * request), so the pages show their filled states and not only the empty ones. On a phone each page is read again with
 * the Menu sheet open, and one confirmation dialog is read on the event page. With `LAYOUT_SHOTS=<folder>` it also
 * saves a full-page screenshot of each.
 */
const LANGUAGES = ["en", "ar"] as const;
type Language = (typeof LANGUAGES)[number];
const PASSWORD = "an organizer's own pass phrase";
const SHOTS = process.env["LAYOUT_SHOTS"];
const CONTROL = `http://127.0.0.1:${CONTROL_PORT}`;
const API = "http://127.0.0.1:4100";
const WEB = "http://localhost:3100";
/** The pages that also have the top bar and the navigation read in their hover and focus states (once is enough). */
const CHROME_PAGES = new Set(["sign-in", "event", "home", "console"]);

/** A full-page screenshot, or with `fullPage` false only the screen (a menu or dialog is fixed to the screen). */
async function shoot(page: Page, project: string, name: string, fullPage = true): Promise<void> {
  if (SHOTS === undefined || SHOTS === "") {
    return;
  }
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${project}-${name}.png`), fullPage });
}

/** One call to the test control (the server's back door for what only the platform does). */
async function control(page: Page, path: string, data: object = {}): Promise<unknown> {
  const response = await page.request.post(`${CONTROL}${path}`, { data });
  expect(response.status(), `${path}: ${await response.text()}`).toBeLessThan(300);
  return response.status() === 204 ? undefined : response.json();
}

/** One call to the API as the signed-in owner, from the dashboard's own origin. */
async function send(page: Page, method: "POST" | "PUT", path: string, data: object) {
  const response = await page.request.fetch(path, {
    method,
    data,
    headers: { origin: WEB, "idempotency-key": crypto.randomUUID() },
  });
  expect(response.status(), `${method} ${path}: ${await response.text()}`).toBeLessThan(300);
  return response;
}

type Event = Readonly<{ organizerId: string; eventId: string }>;

/** A new organizer's owner with one draft event that has one quest; returns where they live. */
async function createEvent(page: Page, project: string): Promise<Event> {
  const email = `layout.${project}.${Date.now()}.${Math.floor(Math.random() * 1e6)}@riyadh.test`;
  await page.goto("/en/sign-up");
  await page.getByLabel("Organizer name", { exact: true }).fill("Najd Layout Co");
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
async function fillShop(page: Page, ids: Event): Promise<void> {
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
async function startAndFill(page: Page, ids: Event): Promise<LayoutIds> {
  const { eventId, organizerId } = ids;
  const base = `/v1/organizers/${organizerId}/events/${eventId}`;
  const tag = `${Date.now() % 1_000_000}`;
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
  await control(page, "/invitation-event", { eventId, days: 10 });
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
  return { organizerId, eventId, joinCode, ticketId, campaignId: campaignId ?? "" };
}

/** One page, read as it opens; on a phone again with the Menu sheet open; on a desktop its column must fit. */
async function checkPage(
  page: Page,
  project: string,
  language: Language,
  listed: Readonly<{ name: string; ready: LayoutPage["ready"] }>,
  path: string,
): Promise<void> {
  const where = `${language} ${listed.name}`;
  // A page that opens on the error state because the API stalled for a moment is opened again, not read as it is.
  await expect(async () => {
    await page.goto(`/${language}${path}`);
    await expect(
      page.getByText(listed.ready[language]).filter({ visible: true }).first(),
    ).toBeVisible({ timeout: 6000 });
  }).toPass({ timeout: 40_000 });
  await waitUntilSettled(page);
  await expectCleanLayout(page, where);
  await expectNavFits(page, where);
  await shoot(page, project, `${language}-${listed.name}`);
  if (project === "desktop") {
    await expectStateContrast(page, where, "body");
    if (CHROME_PAGES.has(listed.name)) {
      await expectStateContrast(page, where, "chrome");
    }
  }
  if (project === "phone") {
    await openMenu(page);
    await expectCleanLayout(page, `${where} with the menu open`);
    if (listed.name === "event") {
      await shoot(page, project, `${language}-menu-open`, false);
    }
  }
}

/** The event page's Delete draft confirmation, open, read like a page, then closed with Escape. */
async function checkDialog(
  page: Page,
  project: string,
  language: Language,
  ids: Event,
): Promise<void> {
  await page.goto(`/${language}/organizers/${ids.organizerId}/events/${ids.eventId}`);
  await page
    .getByRole("button", { name: language === "en" ? "Delete draft" : "حذف المسودة" })
    .click();
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await expectCleanLayout(page, `${language} event confirmation dialog`);
  await shoot(page, project, `${language}-confirm-dialog`, false);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
}

test("every listed page fits the screen, keeps controls apart and text at 14px or more", async ({
  page,
}, info) => {
  test.setTimeout(900_000);
  page.on("pageerror", (error) => {
    throw error;
  });
  const project = info.project.name;
  await page.setViewportSize(
    project === "phone" ? { width: 360, height: 780 } : { width: 1440, height: 900 },
  );
  await freshAddress(page);
  watchRequests(page);

  for (const listed of PUBLIC_PAGES) {
    for (const language of LANGUAGES) {
      await checkPage(page, project, language, listed, listed.path);
    }
  }

  const created = await createEvent(page, project);
  await fillShop(page, created);
  const draftIds: LayoutIds = { ...created, joinCode: "", ticketId: "", campaignId: "" };
  for (const listed of LAYOUT_PAGES.filter((one) => one.phase === "draft")) {
    for (const language of LANGUAGES) {
      await checkPage(page, project, language, listed, listed.path(draftIds));
    }
  }
  for (const language of LANGUAGES) {
    await checkDialog(page, project, language, created);
  }

  const ids = await startAndFill(page, created);
  for (const listed of LAYOUT_PAGES.filter((one) => one.phase !== "draft")) {
    for (const language of LANGUAGES) {
      await checkPage(page, project, language, listed, listed.path(ids));
    }
  }
});
