import { expect, test, type Browser, type Page, type TestInfo } from "@playwright/test";
import { openBuilder } from "#e2e/builder.ts";
import { CONTROL_PORT } from "#e2e/paths.ts";

const CONTROL = `http://127.0.0.1:${CONTROL_PORT}`;
const TILES = ["database", "events", "push", "sms", "email", "background"] as const;
const REASON = "Laptop lost at the airport";

/**
 * The console's platform pages (T-709), desktop and phone, English and Arabic: the health view with its six equal
 * tiles, the platform numbers, and the admin accounts with the forced sign-out of another admin's session.
 */

async function asAdmin(page: Page, project: string): Promise<void> {
  await openBuilder(page, project);
  const eventId = page.url().split("/").at(-2) ?? "";
  expect((await page.request.post(`${CONTROL}/make-admin`, { data: { eventId } })).status()).toBe(
    204,
  );
}

async function expectNoSidewaysScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

/** A second admin in its own browser; its email is read from the API so its card can be found. */
async function otherAdmin(browser: Browser, info: TestInfo) {
  const context = await browser.newContext({
    baseURL: info.project.use.baseURL ?? "http://localhost:3100",
  });
  const page = await context.newPage();
  await asAdmin(page, info.project.name);
  const me = (await (await page.request.get("/v1/staff/me")).json()) as { email: string };
  return { context, page, email: me.email };
}

test("in English the health view shows six equal tiles with a state, and View more opens the facts", async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  await asAdmin(page, info.project.name);
  await page.goto("/en/console/health");
  await expect(page.getByRole("heading", { name: "Health", level: 1 })).toBeVisible();
  for (const key of TILES) {
    const tile = page.getByTestId(`health-${key}`);
    await expect(tile).toBeVisible();
    await expect(tile.getByTestId("health-state")).toHaveText(/^(OK|Warning|Down)$/);
    await expect(tile.locator("svg").first()).toBeVisible();
  }
  await expect(page.getByTestId("health-database")).toHaveAttribute("data-state", "ok");
  await expect(
    page.getByTestId("health-push").getByText("Not set up on this server."),
  ).toBeVisible();

  const boxes = await Promise.all(
    TILES.map(async (key) => page.getByTestId(`health-${key}`).boundingBox()),
  );
  const rows = new Map<number, number[]>();
  for (const box of boxes) {
    expect(box).not.toBeNull();
    rows.set(Math.round(box?.y ?? 0), [
      ...(rows.get(Math.round(box?.y ?? 0)) ?? []),
      box?.height ?? 0,
    ]);
  }
  for (const heights of rows.values()) {
    expect(Math.max(...heights) - Math.min(...heights)).toBeLessThanOrEqual(1);
  }

  const events = page.getByTestId("health-events");
  await events.getByRole("button", { name: "View more" }).click();
  await expect(events.getByText("Late to start or end")).toBeVisible();
  await expect(events.getByText("Busiest live events")).toBeVisible();
  await events.getByRole("button", { name: "View less" }).click();
  await expect(events.getByText("Late to start or end")).toHaveCount(0);
  await expectNoSidewaysScroll(page);
});

test("in Arabic the health view reads right to left with the states in words", async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  await asAdmin(page, info.project.name);
  await page.goto("/ar/console/health");
  await expect(page.getByRole("heading", { name: "حالة النظام", level: 1 })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByTestId("health-database").getByTestId("health-state")).toHaveText("سليم");
  await page.getByTestId("health-push").getByRole("button", { name: "عرض المزيد" }).click();
  await expect(page.getByTestId("health-push").getByText("آيفون")).toBeVisible();
  await expectNoSidewaysScroll(page);
});

test("the platform numbers show counts in groups, in both languages", async ({ page }, info) => {
  test.setTimeout(120_000);
  await asAdmin(page, info.project.name);
  await page.goto("/en/console/numbers");
  await expect(page.getByRole("heading", { name: "Platform numbers", level: 1 })).toBeVisible();
  for (const group of ["Organizers", "Events", "Players", "Activity", "Staff"]) {
    await expect(page.getByRole("heading", { name: group, level: 2 })).toBeVisible();
  }
  await expect(page.getByText("Points entries, last hour")).toBeVisible();
  await expectNoSidewaysScroll(page);
  await page.goto("/ar/console/numbers");
  await expect(page.getByRole("heading", { name: "أرقام المنصة", level: 1 })).toBeVisible();
  await expect(page.getByText("لاعبون في فعاليات مباشرة")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expectNoSidewaysScroll(page);
});

test("an admin sees their own session without an end button, and ends another admin's session", async ({
  page,
  browser,
}, info) => {
  test.setTimeout(180_000);
  const other = await otherAdmin(browser, info);
  await asAdmin(page, info.project.name);
  const me = (await (await page.request.get("/v1/staff/me")).json()) as { email: string };
  await page.goto("/en/console/admins");
  await expect(page.getByRole("heading", { name: "Admins", level: 1 })).toBeVisible();

  const mine = page.getByTestId("admin-account").filter({ hasText: me.email });
  await mine.getByRole("button", { name: "Show sessions" }).click();
  await expect(mine.getByText("This session")).toBeVisible();

  const theirs = page.getByTestId("admin-account").filter({ hasText: other.email });
  await expect(theirs).toHaveCount(1);
  await theirs.getByRole("button", { name: "Show sessions" }).click();
  await expect(theirs.getByTestId("admin-session")).toHaveCount(1);
  const end = theirs.getByRole("button", { name: "End session" });
  await expect(end).toBeDisabled();
  await theirs.getByLabel("Reason (kept in the audit log)").fill(REASON);
  await end.click();
  await expect(page.getByText(`End this session now? ${other.email} is signed out`)).toBeVisible();
  await page.getByRole("alert").getByRole("button", { name: "End session" }).click();
  await expect(page.getByText("Session ended.")).toBeVisible();
  await expect(theirs.getByText("Open sessions: 0")).toBeVisible();

  await other.page.goto("/en/console/health");
  await expect(other.page).toHaveURL(/\/sign-in/);
  await expectNoSidewaysScroll(page);
  await other.context.close();
});

test("in Arabic the admin cards read right to left", async ({ page }, info) => {
  test.setTimeout(120_000);
  await asAdmin(page, info.project.name);
  await page.goto("/ar/console/admins");
  await expect(page.getByRole("heading", { name: "المشرفون", level: 1 })).toBeVisible();
  await page.getByRole("button", { name: "عرض الجلسات" }).first().click();
  await expect(page.getByTestId("admin-sessions").first()).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expectNoSidewaysScroll(page);
});

test("a person who is not an admin does not get the pages' data", async ({ page }, info) => {
  test.setTimeout(120_000);
  await openBuilder(page, info.project.name);
  for (const path of ["health", "numbers", "admins"]) {
    expect((await page.request.get(`/v1/admin/${path}`)).status()).toBe(404);
  }
});
