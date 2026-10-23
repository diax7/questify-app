import { expect, test, type Page } from "@playwright/test";
import { PASSWORD, account, codeFor, freshAddress, linkFor, signIn } from "#e2e/mail.ts";

const NEW_PASSWORD = "an organizer's own pass phrase";

/** An address no earlier run has used, so sign-up and invites start fresh every time. */
const uniqueEmail = (who: string, project: string): string =>
  `${who}.${project}.${Date.now()}.${Math.floor(Math.random() * 1e6)}@riyadh.test`;

async function fillNewPassword(page: Page, password: string): Promise<void> {
  await page.getByLabel("New password", { exact: true }).fill(password);
  await page.getByLabel("Type the new password again", { exact: true }).fill(password);
}

async function acceptAllDocuments(page: Page): Promise<void> {
  await page.getByLabel("I accept the organizer terms").check();
  await page.getByLabel("I accept the data processing agreement").check();
  await page.getByLabel("I accept the content rules").check();
}

test("signs up as a new organizer and lands home as its owner", async ({ page }, info) => {
  await freshAddress(page);
  const email = uniqueEmail("founder", info.project.name);
  await page.goto("/en/sign-in");
  await page.getByRole("link", { name: "New organizer? Create an account" }).click();
  await expect(page).toHaveURL(/\/en\/sign-up$/);
  await page.getByLabel("Organizer name").fill("Riyadh Expo");
  await page.getByLabel("Email").fill(email);
  await fillNewPassword(page, NEW_PASSWORD);
  await acceptAllDocuments(page);
  await page.getByRole("button", { name: "Create the account" }).click();
  await page.getByRole("textbox", { name: "Sign-in code" }).fill(await codeFor(email));
  await page.getByRole("button", { name: "Create the account" }).click();
  await expect(page).toHaveURL(/\/en$/);
  await expect(page.getByText("Riyadh Expo")).toBeVisible();
  await expect(page.getByText("Owner", { exact: true })).toBeVisible();
});

test("opens each organizer document from the sign-up page", async ({ page }) => {
  await freshAddress(page);
  await page.goto("/en/legal/organizer_terms");
  await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
  await page.goto("/ar/legal/organizer_dpa");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  expect((await page.goto("/en/legal/cookie_policy"))?.status()).toBe(404);
});

test("opens each player document in both languages, and the contact page", async ({ page }) => {
  await freshAddress(page);
  for (const [id, ar, en] of [
    ["terms_of_use", "شروط استخدام Questify", "Questify Terms of Use"],
    ["privacy_policy", "سياسة الخصوصية في Questify", "Questify Privacy Policy"],
    ["community_guidelines", "إرشادات مجتمع Questify", "Questify Community Guidelines"],
  ] as const) {
    await page.goto(`/en/legal/${id}`);
    await expect(page.getByRole("heading", { level: 1, name: en })).toBeVisible();
    await expect(page.getByText("v0.1")).toBeVisible();
    await page.goto(`/ar/legal/${id}`);
    await expect(page.getByRole("heading", { level: 1, name: ar })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  }
  await page.goto("/en/contact");
  await expect(page.getByRole("heading", { level: 1, name: "Contact us" })).toBeVisible();
  await page.goto("/ar/contact");
  await expect(page.getByRole("heading", { level: 1, name: "تواصل معنا" })).toBeVisible();
});

test("an owner invites an editor, who joins with a new password and the emailed code", async ({
  page,
  browser,
}, info) => {
  // Two people sign up and sign in here, each with an emailed code.
  test.setTimeout(90_000);
  await freshAddress(page);
  const ownerEmail = uniqueEmail("owner", info.project.name);
  await page.goto("/en/sign-up");
  await page.getByLabel("Organizer name").fill("Najd Team Co");
  await page.getByLabel("Email").fill(ownerEmail);
  await fillNewPassword(page, NEW_PASSWORD);
  await acceptAllDocuments(page);
  await page.getByRole("button", { name: "Create the account" }).click();
  await page.getByRole("textbox", { name: "Sign-in code" }).fill(await codeFor(ownerEmail));
  await page.getByRole("button", { name: "Create the account" }).click();
  await expect(page).toHaveURL(/\/en$/);

  // An event for the editor to look at: the ranking switch is the owner's (FR-607).
  await page.getByRole("link", { name: "Events" }).click();
  await page.getByRole("link", { name: "New event" }).click();
  await page.getByLabel("Name in English", { exact: true }).fill("Team Rally");
  await page.getByLabel("Starts", { exact: true }).fill("2030-11-01T09:00");
  await page.getByLabel("Ends", { exact: true }).fill("2030-11-01T17:00");
  await page.getByRole("button", { name: "Create event" }).click();
  await expect(page.getByRole("checkbox", { name: "Show the ranking in the app" })).toBeChecked();
  await page.getByRole("link", { name: "Home" }).click();

  await page.getByRole("link", { name: "Team" }).click();
  const editorEmail = uniqueEmail("editor", info.project.name);
  const invite = page.getByRole("form", { name: "Invite an editor" });
  await invite.getByLabel("Email").fill(editorEmail);
  await invite.getByRole("button", { name: "Send the invite" }).click();
  await expect(page.getByRole("status")).toContainText("We sent the invite.");

  const guest = await browser.newContext();
  const editor = await guest.newPage();
  try {
    await freshAddress(editor);
    await editor.goto(await linkFor(editorEmail));
    await expect(
      editor.getByText("You are invited to join Najd Team Co as an editor."),
    ).toBeVisible();
    await expect(editor).not.toHaveURL(/token=/);
    await fillNewPassword(editor, NEW_PASSWORD);
    await editor.getByRole("button", { name: "Accept the invite" }).click();
    await editor.getByRole("textbox", { name: "Sign-in code" }).fill(await codeFor(editorEmail));
    await editor.getByRole("button", { name: "Sign in" }).click();
    await expect(editor).toHaveURL(/\/en$/);
    await expect(editor.getByText("Najd Team Co")).toBeVisible();
    await expect(editor.getByText("Editor", { exact: true })).toBeVisible();
    await editor.getByRole("link", { name: "Team" }).click();
    await expect(editor.getByText(ownerEmail)).toBeVisible();
    await expect(editor.getByRole("form", { name: "Invite an editor" })).toHaveCount(0);
    await editor.getByRole("link", { name: "Home" }).click();
    await editor.getByRole("link", { name: "Events" }).click();
    await editor.getByRole("link", { name: "Team Rally" }).click();
    await expect(editor.getByText("The ranking shows in the app.", { exact: false })).toBeVisible();
    // The ranking and share-quest switches (T-303) each say so.
    await expect(editor.getByText("Only the owner can change this.", { exact: false })).toHaveCount(
      2,
    );
    await expect(editor.getByRole("checkbox", { name: "Show the ranking in the app" })).toHaveCount(
      0,
    );
  } finally {
    await guest.close();
  }
});

test("someone with an account creates a second organizer from home", async ({ page }, info) => {
  await freshAddress(page);
  await signIn(page, account("creator", info), PASSWORD);
  await page.getByRole("link", { name: "New organizer" }).click();
  await page.getByLabel("Organizer name").fill(`Second Venture ${info.project.name}`);
  await acceptAllDocuments(page);
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page).toHaveURL(/\/en$/);
  await expect(page.getByText(`Second Venture ${info.project.name}`).first()).toBeVisible();
});

test.describe("an Arabic browser", () => {
  test.use({ locale: "ar-SA" });

  test("shows the sign-up form right to left without sideways scrolling", async ({ page }) => {
    await freshAddress(page);
    await page.goto("/ar/sign-up");
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(page.getByRole("heading", { name: "إنشاء حساب منظِّم" })).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
