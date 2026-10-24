import { expect, type Page } from "@playwright/test";
import { codeFor, freshAddress } from "#e2e/mail.ts";

const PASSWORD = "an organizer's own pass phrase";

/** Signs up as a new organizer's owner, creates a draft event, and opens its quest builder in Arabic. */
export async function openBuilder(page: Page, project: string): Promise<void> {
  page.on("pageerror", (error) => {
    throw error;
  });
  const email = `quests.${project}.${Date.now()}.${Math.floor(Math.random() * 1e6)}@riyadh.test`;
  await freshAddress(page);
  await page.goto("/en/sign-up");
  await page.getByLabel("Organizer name").fill("Najd Quests Co");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("New password", { exact: true }).fill(PASSWORD);
  await page.getByLabel("Type the new password again", { exact: true }).fill(PASSWORD);
  await page.getByLabel("I accept the organizer terms").check();
  await page.getByLabel("I accept the data processing agreement").check();
  await page.getByLabel("I accept the content rules").check();
  await page.getByRole("button", { name: "Create the account" }).click();
  await page.getByRole("textbox", { name: "Sign-in code" }).fill(await codeFor(email));
  await page.getByRole("button", { name: "Create the account" }).click();
  await expect(page).toHaveURL(/\/en$/);
  await page.goto(page.url().replace(/\/en$/, "/ar"));
  await page.getByRole("link", { name: "الفعاليات" }).click();
  await page.getByRole("link", { name: "فعالية جديدة" }).click();
  await page.getByLabel("الاسم بالعربية", { exact: true }).fill("ملتقى نجد");
  await page.getByLabel("تبدأ", { exact: true }).fill("2030-11-01T09:00");
  await page.getByLabel("تنتهي", { exact: true }).fill("2030-11-01T17:00");
  await page.getByRole("button", { name: "إنشاء الفعالية" }).click();
  await page.getByRole("link", { name: "مهام", exact: true }).click();
  await expect(page.getByRole("heading", { name: "مهام", level: 1 })).toBeVisible();
}
