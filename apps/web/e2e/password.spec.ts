import { expect, test } from "@playwright/test";
import {
  BREACHED_PASSWORD,
  PASSWORD,
  account,
  codeFor,
  freshAddress,
  linkFor,
  signIn,
} from "#e2e/mail.ts";
import { openMenu } from "#e2e/nav.ts";

const NEW_PASSWORD = "a brand new pass phrase 77";

test("resets a forgotten password from the emailed link, then signs in with the new one", async ({
  page,
}, info) => {
  await freshAddress(page);
  const email = account("reset", info);
  await page.goto("/en/sign-in");
  await page.getByRole("link", { name: "Forgot your password?" }).click();
  await expect(page).toHaveURL(/\/en\/forgot-password$/);
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Send the link" }).click();
  await expect(page.getByRole("status")).toContainText("If an account uses this email");

  await page.goto(await linkFor(email));
  await expect(page.getByRole("heading", { name: "Choose a new password" })).toBeVisible();
  await expect(page).not.toHaveURL(/token=/);

  const fill = async (first: string, second: string): Promise<void> => {
    await page.getByLabel("New password", { exact: true }).fill(first);
    await page.getByLabel("Type the new password again", { exact: true }).fill(second);
    await page.getByRole("button", { name: "Save the password" }).click();
  };
  await fill(NEW_PASSWORD, `${NEW_PASSWORD}!`);
  await expect(
    page.getByRole("alert").filter({ hasText: "The two passwords do not match." }),
  ).toBeVisible();
  await fill(BREACHED_PASSWORD, BREACHED_PASSWORD);
  await expect(
    page.getByRole("alert").filter({ hasText: "appeared in a known data breach" }),
  ).toBeVisible();
  await fill(NEW_PASSWORD, NEW_PASSWORD);
  await expect(page.getByRole("status")).toContainText("Your new password is saved.");

  await page.getByRole("link", { name: "Sign in" }).click();
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "The email or password is not correct." }),
  ).toBeVisible();
  await page.getByLabel("Password").fill(NEW_PASSWORD);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("textbox", { name: "Sign-in code" }).fill(await codeFor(email));
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/en$/);
});

test("after a refresh the reset page asks for the email link again instead of a broken form", async ({
  page,
}, info) => {
  await freshAddress(page);
  const email = account("reset", info);
  const before = await linkFor(email).catch(() => undefined);
  await page.goto("/en/forgot-password");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Send the link" }).click();
  await page.goto(await linkFor(email, before));
  await expect(page.getByLabel("New password", { exact: true })).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("alert").filter({ hasText: "Open the link from your email again" }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Ask for a new link" })).toBeVisible();
});

test("changes the password while signed in: this browser stays, the other is signed out", async ({
  page,
  browser,
}, info) => {
  await freshAddress(page);
  const email = account("change", info);
  await signIn(page, email);
  const other = await browser.newContext();
  const elsewhere = await other.newPage();
  try {
    await freshAddress(elsewhere);
    await signIn(elsewhere, email);

    await openMenu(page);
    await page.getByRole("link", { name: "My account" }).click();
    await expect(page).toHaveURL(/\/en\/account$/);
    await page.getByLabel("Current password", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: "Show password" }).first().click();
    await expect(page.getByLabel("Current password", { exact: true })).toHaveAttribute(
      "type",
      "text",
    );
    await page.getByLabel("New password", { exact: true }).fill(NEW_PASSWORD);
    await page.getByLabel("Type the new password again", { exact: true }).fill(NEW_PASSWORD);
    await page.getByRole("button", { name: "Save the password" }).click();
    await expect(page.getByRole("status")).toContainText("Your password is changed");

    await elsewhere.goto("/en");
    await expect(elsewhere).toHaveURL(/\/en\/sign-in/);
    await page.reload();
    await expect(page).toHaveURL(/\/en\/account$/);
  } finally {
    await other.close();
  }
});

test.describe("an Arabic browser", () => {
  test.use({ locale: "ar-SA" });

  test("asks for a reset link in Arabic, right to left", async ({ page }) => {
    await freshAddress(page);
    await page.goto("/ar/sign-in");
    await page.getByRole("link", { name: "نسيت كلمة المرور؟" }).click();
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(page.getByRole("heading", { name: "إعادة تعيين كلمة المرور" })).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
