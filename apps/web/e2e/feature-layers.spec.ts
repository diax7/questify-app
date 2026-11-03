import { expect, test, type Page } from "@playwright/test";
import { openBuilder } from "#e2e/builder.ts";
import { CONTROL_PORT } from "#e2e/paths.ts";

const WEB = "http://localhost:3100";
const CONTROL = `http://127.0.0.1:${CONTROL_PORT}`;

/**
 * The feature layers (T-711, FR-1826, FR-1827), desktop and phone, English and Arabic: the platform switches a feature
 * off and the owner no longer sees its switch; Questify sets it On for one organizer in the console and the switch comes
 * back; an override Off takes it away and the server refuses the owner's switch-on; an add-on Questify has not allowed is a
 * locked card with Ask Questify. The platform settings are shared by every spec, so each test puts back what it changed.
 */
async function asAdmin(
  page: Page,
  project: string,
): Promise<{ organizerId: string; eventId: string }> {
  await openBuilder(page, project);
  const parts = new URL(page.url()).pathname.split("/");
  const ids = { organizerId: parts[3] ?? "", eventId: parts[5] ?? "" };
  expect(
    (await page.request.post(`${CONTROL}/make-admin`, { data: { eventId: ids.eventId } })).status(),
  ).toBe(204);
  await resetPlatform(page);
  return ids;
}

/** Puts the platform's Maps and Shop switches back to the app's own, whatever an earlier run left. */
async function resetPlatform(page: Page): Promise<void> {
  for (const feature of ["maps", "shop"]) {
    const answer = await page.request.delete(`/v1/admin/switches/features/${feature}`, {
      headers: { origin: WEB },
    });
    expect(answer.status()).toBe(204);
  }
}

async function platformOff(page: Page, feature: string): Promise<void> {
  const answer = await page.request.put(`/v1/admin/switches/features/${feature}`, {
    data: { enabled: false, message: null },
    headers: { origin: WEB },
  });
  expect(answer.status()).toBe(204);
}

async function expectNoSidewaysScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

test("in English the console's override brings a platform-off feature back for one organizer, and Off takes one away", async ({
  page,
}, info) => {
  test.setTimeout(150_000);
  const { organizerId, eventId } = await asAdmin(page, info.project.name);
  const eventPage = `/en/organizers/${organizerId}/events/${eventId}`;
  const consolePage = `/en/console/organizers/${organizerId}`;
  const maps = page.getByRole("checkbox", { name: "Show maps in the event" });
  const shop = page.getByRole("checkbox", { name: "Show the shop in the event" });

  await platformOff(page, "maps");
  await page.goto(eventPage);
  await expect(shop).toBeVisible();
  await expect(maps).toHaveCount(0);

  await page.goto(consolePage);
  const mapsCard = page.locator('[data-testid="override-card"][data-feature="maps"]');
  await expect(mapsCard.getByText("Off for everyone")).toBeVisible();
  await mapsCard.getByLabel("Maps for this organizer").selectOption("on");
  await expect(page.getByText("Change saved.")).toBeVisible();
  await expect(mapsCard.getByText("Override: on")).toBeVisible();

  await page.goto(eventPage);
  await expect(maps).toBeVisible();

  await page.goto(consolePage);
  const shopCard = page.locator('[data-testid="override-card"][data-feature="shop"]');
  await shopCard.getByLabel("Shop for this organizer").selectOption("off");
  await expect(shopCard.getByText("Override: off")).toBeVisible();
  await page.goto(eventPage);
  await expect(maps).toBeVisible();
  await expect(shop).toHaveCount(0);

  const refused = await page.request.put(
    `/v1/organizers/${organizerId}/events/${eventId}/features/shop`,
    { data: { enabled: true }, headers: { origin: WEB } },
  );
  expect(refused.status()).toBe(403);
  expect(((await refused.json()) as { code: string }).code).toBe("feature_not_allowed");

  await page.goto(consolePage);
  await shopCard.getByLabel("Shop for this organizer").selectOption("platform");
  await mapsCard.getByLabel("Maps for this organizer").selectOption("platform");
  await expect(mapsCard.getByText("Override: on")).toHaveCount(0);
  await expect(shopCard.getByText("Override: off")).toHaveCount(0);
  await resetPlatform(page);
});

test("in English an add-on Questify has not allowed is a locked card with Ask Questify", async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  const { organizerId, eventId } = await asAdmin(page, info.project.name);
  await page.goto(`/en/organizers/${organizerId}/events/${eventId}`);
  const features = page.getByRole("region", { name: "Features" });
  await expect(features.getByText("Available with an add-on.")).toBeVisible();
  await expect(features.getByRole("checkbox", { name: "Big screen" })).toBeDisabled();
  await expect(features.getByRole("link", { name: "Ask Questify" })).toHaveAttribute(
    "href",
    "/en/contact",
  );

  const switchOn = await page.request.put(
    `/v1/organizers/${organizerId}/events/${eventId}/features/bigScreen`,
    { data: { enabled: true }, headers: { origin: WEB } },
  );
  expect(switchOn.status()).toBe(404);
});

test("in Arabic the overrides and the locked card mirror, name every feature, and do not scroll sideways", async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  const { organizerId, eventId } = await asAdmin(page, info.project.name);
  await page.goto(`/ar/console/organizers/${organizerId}`);
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  const mapsCard = page.locator('[data-testid="override-card"][data-feature="maps"]');
  await expect(mapsCard.getByText("تعمل للجميع")).toBeVisible();
  await expect(mapsCard.getByLabel("الخرائط لهذه الجهة")).toHaveValue("platform");
  await expect(page.getByTestId("override-card")).toHaveCount(12);
  await expectNoSidewaysScroll(page);

  await page.goto(`/ar/organizers/${organizerId}/events/${eventId}`);
  const features = page.getByRole("region", { name: "الميزات" });
  await expect(features.getByText("متاحة مع إضافة.")).toBeVisible();
  await expect(features.getByRole("link", { name: "اسأل Questify" })).toHaveAttribute(
    "href",
    "/ar/contact",
  );
  await expectNoSidewaysScroll(page);
});
