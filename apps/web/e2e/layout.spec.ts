import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { LAYOUT_PAGES, expectCleanLayout, type LayoutIds } from "#e2e/layout.ts";
import { codeFor, freshAddress } from "#e2e/mail.ts";

/**
 * The layout check (ADR-364, T-599): every page listed in `LAYOUT_PAGES`, in English and Arabic, at 1440 wide on the
 * desktop project and 390 on the phone project, with no sideways scrolling, no controls on top of each other and no
 * text under 14px. With `LAYOUT_SHOTS=<folder>` it also saves a full-page screenshot of each.
 */
const LANGUAGES = ["en", "ar"] as const;
const PASSWORD = "an organizer's own pass phrase";
const SHOTS = process.env["LAYOUT_SHOTS"];

async function shoot(page: Page, project: string, name: string): Promise<void> {
  if (SHOTS === undefined || SHOTS === "") {
    return;
  }
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${project}-${name}.png`), fullPage: true });
}

/** A new organizer's owner with one draft event that has one quest; returns where they live. */
async function seed(page: Page, project: string): Promise<LayoutIds> {
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

test("every listed page fits the screen, keeps controls apart and text at 14px or more", async ({
  page,
}, info) => {
  test.setTimeout(240_000);
  page.on("pageerror", (error) => {
    throw error;
  });
  const project = info.project.name;
  await page.setViewportSize(
    project === "phone" ? { width: 390, height: 844 } : { width: 1440, height: 900 },
  );
  await freshAddress(page);

  for (const language of LANGUAGES) {
    await page.goto(`/${language}/sign-in`);
    await expect(page.getByRole("button").first()).toBeVisible();
    await expectCleanLayout(page, `${language} sign-in`);
    await shoot(page, project, `${language}-sign-in`);
  }

  const ids = await seed(page, project);
  for (const listed of LAYOUT_PAGES) {
    for (const language of LANGUAGES) {
      await page.goto(`/${language}${listed.path(ids)}`);
      await expect(page.getByText(listed.ready[language]).first()).toBeVisible();
      await page.waitForLoadState("networkidle");
      await expectCleanLayout(page, `${language} ${listed.name}`);
      await shoot(page, project, `${language}-${listed.name}`);
    }
  }
});
