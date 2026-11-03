import { expect, test, type Page } from "@playwright/test";
import { openBuilder } from "#e2e/builder.ts";
import { CONTROL_PORT } from "#e2e/paths.ts";

const WEB = "http://localhost:3100";
const CONTROL = `http://127.0.0.1:${CONTROL_PORT}`;
const HEADERS = { origin: WEB };

/**
 * The console's Maintenance and banner tab (T-703b, FR-1771, FR-1772), desktop and phone, English and Arabic. The platform
 * settings are shared by every spec, so these tests pause only the event they create (never the whole platform, which
 * would hold every other spec's players) and take the banner down before they end.
 */
async function asAdmin(
  page: Page,
  project: string,
): Promise<{ eventId: string; joinCode: string }> {
  await openBuilder(page, project);
  const eventId = page.url().split("/").at(-2) ?? "";
  expect((await page.request.post(`${CONTROL}/make-admin`, { data: { eventId } })).status()).toBe(
    204,
  );
  expect(
    (await page.request.delete("/v1/admin/switches/banner", { headers: HEADERS })).status(),
  ).toBe(204);
  const organizerId = /\/organizers\/([^/]+)\//.exec(page.url())?.[1] ?? "";
  const event = await page.request.get(`/v1/organizers/${organizerId}/events/${eventId}`);
  const joinCode = ((await event.json()) as { event: { joinCode: string } }).event.joinCode;
  return { eventId, joinCode };
}

async function expectNoSidewaysScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

type Notices = {
  maintenance: { events: { eventId: string; message: { en: string } }[] };
  banner: { message: { en: string }; startsAt: string; endsAt: string } | null;
};

const noticesOf = async (page: Page): Promise<Notices> =>
  (await (await page.request.get("/v1/admin/switches/notices")).json()) as Notices;

test("in English an event is paused with a message, then resumed", async ({ page }, info) => {
  test.setTimeout(120_000);
  const { eventId, joinCode } = await asAdmin(page, info.project.name);
  await page.goto("/en/console/switches");
  await page.getByRole("button", { name: "Maintenance and banner", exact: true }).click();
  await expect(page.getByTestId("paused-event")).toHaveCount(0);
  await expect(page.getByText("No event is paused.")).toBeVisible();

  const card = page.getByTestId("maintenance-events");
  await card.getByLabel("Event join code").fill(joinCode);
  await card.getByLabel("Message for players · English").fill("Back at noon.");
  await expect(card.getByRole("button", { name: "Pause event" })).toBeDisabled();
  await expect(card.getByText("Check the marked fields before saving.")).toBeVisible();
  await card.getByLabel("Message for players · Arabic").fill("نعود عند الظهر.");
  await card.getByRole("button", { name: "Pause event" }).click();
  await expect(page.getByText("Change saved.")).toBeVisible();
  await expect(page.getByTestId("paused-event")).toHaveCount(1);
  await expect(page.getByTestId("paused-event")).toContainText("Back at noon.");
  expect((await noticesOf(page)).maintenance.events.map((row) => row.eventId)).toEqual([eventId]);

  await page
    .getByTestId("paused-event")
    .getByRole("button", { name: /^Resume / })
    .click();
  await expect(page.getByTestId("paused-event")).toHaveCount(0);
  expect((await noticesOf(page)).maintenance.events).toEqual([]);
});

test("in English the banner is scheduled with a window the apps read, then removed", async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  await asAdmin(page, info.project.name);
  await page.goto("/en/console/switches");
  await page.getByRole("button", { name: "Maintenance and banner", exact: true }).click();
  const card = page.getByTestId("banner");
  await card.getByLabel("Message for players · English").fill("Opening night is here.");
  await card.getByLabel("Message for players · Arabic").fill("ليلة الافتتاح وصلت.");
  await card.getByLabel("Starts at").fill("2030-11-01T10:00");
  await card.getByLabel("Ends at").fill("2030-11-01T09:00");
  await expect(card.getByRole("button", { name: "Schedule banner" })).toBeDisabled();
  await card.getByLabel("Ends at").fill("2030-11-01T20:00");
  await card.getByRole("button", { name: "Schedule banner" }).click();
  await expect(page.getByText("Change saved.")).toBeVisible();

  await expect
    .poll(async () => ((await noticesOf(page)).banner ?? { message: { en: "" } }).message.en)
    .toBe("Opening night is here.");
  const config = (await (await page.request.get("/v1/config")).json()) as Notices;
  expect(config.banner?.message.en).toBe("Opening night is here.");
  expect(Date.parse(config.banner?.endsAt ?? "") - Date.parse(config.banner?.startsAt ?? "")).toBe(
    10 * 3_600_000,
  );

  await card.getByRole("button", { name: "Remove banner" }).click();
  await expect.poll(async () => (await noticesOf(page)).banner).toBeNull();
  const cleared = (await (await page.request.get("/v1/config")).json()) as Notices;
  expect(cleared.banner).toBeNull();
});

test("in Arabic the tab mirrors, names its parts, and does not scroll sideways", async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  await asAdmin(page, info.project.name);
  await page.goto("/ar/console/switches");
  await page.getByRole("button", { name: "الصيانة واللافتة", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByText("إيقاف اللعب في كل الفعاليات")).toBeVisible();
  await expect(page.getByText("فعاليات موقوفة")).toBeVisible();
  await expect(page.getByText("لافتة الصفحة الرئيسية")).toBeVisible();
  await expectNoSidewaysScroll(page);
});
