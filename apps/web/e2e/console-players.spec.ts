import { expect, test, type Page } from "@playwright/test";
import { openBuilder } from "#e2e/builder.ts";
import { CONTROL_PORT } from "#e2e/paths.ts";

const CONTROL = `http://127.0.0.1:${CONTROL_PORT}`;
const NOTE = "Ticket 5512 from the help desk";

/**
 * The console's player tools (T-704), desktop and phone, English and Arabic: find a player by username, open the
 * read-only record, and the three actions that each need a reason and one confirmation.
 */

/** Signs in as a new organizer made a platform admin, and enrolls one new player in its event; the player's name. */
async function adminWithPlayer(page: Page, project: string): Promise<string> {
  await openBuilder(page, project);
  const eventId = page.url().split("/").at(-2) ?? "";
  expect((await page.request.post(`${CONTROL}/make-admin`, { data: { eventId } })).status()).toBe(
    204,
  );
  const username = `pt_${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
  const made = await page.request.post(`${CONTROL}/players`, {
    data: { eventId, usernames: [username] },
  });
  expect(made.status()).toBe(204);
  return username;
}

async function expectNoSidewaysScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

async function openRecord(page: Page, language: "en" | "ar", username: string): Promise<void> {
  await page.goto(`/${language}/console/players`);
  await page.getByRole("searchbox").fill(username);
  await page.getByRole("button", { name: language === "en" ? "Find" : "بحث" }).click();
  await page.getByRole("link", { name: `@${username}` }).click();
  await expect(page.getByRole("heading", { name: `@${username}`, level: 1 })).toBeVisible();
}

/** Fills an action's reason and note inside its section, then confirms it once. */
async function act(page: Page, section: string, button: string, reason: string): Promise<void> {
  const part = page.getByRole("region", { name: section });
  await part.getByRole("combobox").last().selectOption({ label: reason });
  await part.getByRole("textbox").last().fill(NOTE);
  await part.getByRole("button", { name: button }).click();
  await part.getByRole("alert").getByRole("button", { name: button }).click();
}

test("in English an admin finds a player, reads the record, changes the name and resets the sign-in", async ({
  page,
}, info) => {
  test.setTimeout(150_000);
  const username = await adminWithPlayer(page, info.project.name);
  await openRecord(page, "en", username);
  for (const heading of [
    "Profile",
    "Contacts",
    "Events",
    "Flags",
    "Points record",
    "Questify actions",
  ]) {
    await expect(page.getByRole("heading", { name: heading, level: 2 })).toBeVisible();
  }
  await expect(page.getByText("No points yet.")).toBeVisible();
  await expectNoSidewaysScroll(page);

  await act(page, "Show full contacts", "Show full contacts", "Support request");
  await expect(page.getByLabel("Full contacts (shown once)")).toBeVisible();

  const renamed = `${username}_x`;
  await page
    .getByRole("region", { name: "Change username" })
    .getByLabel("New username")
    .fill(renamed);
  await act(page, "Change username", "Change username", "Offensive name");
  await expect(page.getByText("Username changed.")).toBeVisible();
  await expect(page.getByRole("heading", { name: `@${renamed}`, level: 1 })).toBeVisible();
  await expect(page.getByText("Changed by Questify")).toBeVisible();

  await act(page, "Reset sign-in", "Reset sign-in", "Lost their phone or email");
  await expect(page.getByText(/^Signed out on \d+ devices\.$/)).toBeVisible();
  await expect(page.getByText("Sign-in reset")).toBeVisible();
  await expectNoSidewaysScroll(page);
});

test("in Arabic the player tools read right to left with Western digits", async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  const username = await adminWithPlayer(page, info.project.name);
  await openRecord(page, "ar", username);
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByRole("heading", { name: "سجل النقاط", level: 2 })).toBeVisible();
  await expect(page.getByText("لا توجد نقاط بعد.")).toBeVisible();
  await expect(page.getByText(/المستوى \d+ · \d+ نقطة خبرة/)).toBeVisible();
  await expectNoSidewaysScroll(page);
});
