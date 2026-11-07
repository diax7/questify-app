import { expect, test, type Page, type Route } from "@playwright/test";
import { openBuilder } from "#e2e/builder.ts";
import { CONTROL_PORT } from "#e2e/paths.ts";

const WEB = "http://localhost:3100";
const CONTROL = `http://127.0.0.1:${CONTROL_PORT}`;

/**
 * The feature layers (T-711, FR-1826, FR-1827), desktop and phone, English and Arabic: the platform switches a feature
 * off and the owner no longer sees its switch; Questify sets it On for one organizer in the console and the switch comes
 * back; an override Off takes it away and the server refuses the owner's switch-on; an add-on Questify has not allowed is a
 * locked card whose Ask Questify records a request that the console's home lists and Allow unlocks (T-711b). The platform
 * settings are shared by every spec, so each test puts back what it changed.
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
  await expect(shopCard.getByText("Override: off")).toHaveCount(0);
  await mapsCard.getByLabel("Maps for this organizer").selectOption("platform");
  await expect(mapsCard.getByText("Override: on")).toHaveCount(0);
  await resetPlatform(page);
});

test("a chosen override stays shown, and the selects stay disabled, until the list is read again", async ({
  page,
}, info) => {
  test.setTimeout(150_000);
  const { organizerId } = await asAdmin(page, info.project.name);
  await page.goto(`/en/console/organizers/${organizerId}`);
  const mapsCard = page.locator('[data-testid="override-card"][data-feature="maps"]');
  const mapsSelect = mapsCard.getByLabel("Maps for this organizer");
  const shopSelect = page
    .locator('[data-testid="override-card"][data-feature="shop"]')
    .getByLabel("Shop for this organizer");
  await expect(mapsSelect).toHaveValue("platform");

  // The read that follows the save is held until the test lets it through.
  const held: Route[] = [];
  await page.route(`**/v1/admin/organizers/${organizerId}/features`, (route) => {
    held.push(route);
  });
  await mapsSelect.selectOption("on");
  await expect.poll(() => held.length).toBe(1);
  await expect(mapsSelect).toHaveValue("on");
  await expect(mapsSelect).toBeDisabled();
  await expect(shopSelect).toBeDisabled();
  await held[0]?.continue();
  await expect(mapsCard.getByText("Override: on")).toBeVisible();
  await expect(mapsSelect).toHaveValue("on");
  await expect(mapsSelect).toBeEnabled();
  await expect(shopSelect).toBeEnabled();

  await page.unroute(`**/v1/admin/organizers/${organizerId}/features`);
  await mapsSelect.selectOption("platform");
  await expect(mapsCard.getByText("Override: on")).toHaveCount(0);
  await resetPlatform(page);
});

test("in English the owner asks Questify for a locked add-on, the console allows it, and the add-on works", async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  const { organizerId, eventId } = await asAdmin(page, info.project.name);
  await page.goto(`/en/organizers/${organizerId}/events/${eventId}`);
  const features = page.getByRole("region", { name: "Features" });
  await expect(features.getByText("Available with an add-on.")).toBeVisible();
  await expect(features.getByRole("checkbox", { name: "Big screen" })).toBeDisabled();
  await expect(features.getByRole("link", { name: "Or contact us" })).toHaveAttribute(
    "href",
    "/en/contact",
  );

  const switchOn = await page.request.put(
    `/v1/organizers/${organizerId}/events/${eventId}/features/bigScreen`,
    { data: { enabled: true }, headers: { origin: WEB } },
  );
  expect(switchOn.status()).toBe(404);

  await features.getByRole("button", { name: "Ask Questify" }).click();
  await expect(features.getByText("Requested")).toBeVisible();
  await expect(features.getByRole("button", { name: "Ask Questify" })).toHaveCount(0);

  await page.goto("/en/console");
  const requests = page.getByRole("region", { name: "Add-on requests" });
  const asked = requests
    .getByRole("listitem")
    .filter({ has: page.locator(`a[href$="/console/events/${eventId}"]`) });
  await expect(asked).toHaveCount(1);
  await asked.getByRole("button", { name: "Allow" }).click();
  await expect(asked).toHaveCount(0);
  await expectNoSidewaysScroll(page);

  await page.goto(`/en/organizers/${organizerId}/events/${eventId}`);
  await expect(features.getByText("Unlocked for your event")).toBeVisible();
  await expect(features.getByText("Requested")).toHaveCount(0);
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
  await expect(page.getByTestId("override-card")).toHaveCount(16);
  await expectNoSidewaysScroll(page);

  await page.goto(`/ar/organizers/${organizerId}/events/${eventId}`);
  const features = page.getByRole("region", { name: "الميزات" });
  await expect(features.getByText("متاحة مع إضافة.")).toBeVisible();
  await expect(features.getByRole("button", { name: "اسأل Questify" })).toBeVisible();
  await expect(features.getByRole("link", { name: "أو تواصل معنا" })).toHaveAttribute(
    "href",
    "/ar/contact",
  );
  await expectNoSidewaysScroll(page);
});
