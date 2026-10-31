import { expect, test, type Page } from "@playwright/test";
import { PASSWORD, account, codeFor, freshAddress } from "#e2e/mail.ts";
import { openMenu } from "#e2e/nav.ts";

async function expectNoSidewaysScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

test.describe("an Arabic browser", () => {
  test.use({ locale: "ar-SA" });

  test("signs in and out in Arabic, right to left, without sideways scrolling", async ({
    page,
  }, info) => {
    await freshAddress(page);
    const email = account("ar", info);
    await page.goto("/");
    await expect(page).toHaveURL(/\/ar\/sign-in$/);
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(page.locator("html")).toHaveAttribute("lang", "ar");
    await expectNoSidewaysScroll(page);

    await page.getByLabel("البريد الإلكتروني").fill(email);
    await page.getByLabel("كلمة المرور").fill(PASSWORD);
    await page.getByRole("button", { name: "متابعة" }).click();
    await expect(page.getByRole("heading", { name: "أدخل رمز الدخول" })).toBeVisible();
    await page.getByRole("textbox", { name: "رمز الدخول" }).fill(await codeFor(email));
    await page.getByRole("button", { name: "تسجيل الدخول" }).click();

    await expect(page).toHaveURL(/\/ar$/);
    await expect(page.getByText("Najd Events")).toBeVisible();
    await expect(page.getByText("محرر")).toBeVisible();
    await expectNoSidewaysScroll(page);

    await openMenu(page);
    await page.getByRole("button", { name: "تسجيل الخروج" }).click();
    const asking = page.getByRole("alertdialog");
    await expect(asking).toContainText("ستحتاج إلى تسجيل الدخول من جديد.");
    await asking.getByRole("button", { name: "إلغاء" }).click();
    await expect(page).toHaveURL(/\/ar$/);
    await openMenu(page);
    await page.getByRole("button", { name: "تسجيل الخروج" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "تسجيل الخروج" }).click();
    await expect(page).toHaveURL(/\/ar\/sign-in$/);
    await page.goto("/ar");
    await expect(page).toHaveURL(/\/ar\/sign-in$/);
  });
});

test("in English: a wrong password, a wrong code with attempts left, then in, and the language switch", async ({
  page,
}, info) => {
  await freshAddress(page);
  const email = account("en", info);
  await page.goto("/en/sign-in");
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");

  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("not the password");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "The email or password is not correct." }),
  ).toBeVisible();

  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Continue" }).click();
  const code = await codeFor(email);
  await page
    .getByRole("textbox", { name: "Sign-in code" })
    .fill(code === "000000" ? "111111" : "000000");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Attempts left: 4" })).toBeVisible();

  await page.getByRole("textbox", { name: "Sign-in code" }).fill(code);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/en$/);
  await expect(page.getByText(`Signed in as`)).toContainText(email);

  await page.getByRole("link", { name: "Switch to العربية" }).click();
  await expect(page).toHaveURL(/\/ar$/);
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByText("Najd Events")).toBeVisible();
});

test("signs in with the keyboard alone", async ({ page }, info) => {
  await freshAddress(page);
  const email = account("keys", info);
  await page.goto("/en/sign-in");
  // Skip to content, the product name, the language switch, then the form.
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Email")).toBeFocused();
  await page.keyboard.type(email);
  await page.keyboard.press("Tab");
  await page.keyboard.type(PASSWORD);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("textbox", { name: "Sign-in code" })).toBeFocused();
  await page.keyboard.type(await codeFor(email));
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/en$/);
});

test("waits before another code can be sent, and can start over with another account", async ({
  page,
}, info) => {
  await freshAddress(page);
  await page.goto("/en/sign-in");
  await page.getByLabel("Email").fill(account("resend", info));
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Continue" }).click();
  const resend = page.getByRole("button", { name: /Send a new code \(\d:\d\d\)/ });
  await expect(resend).toBeDisabled();
  await page.getByRole("button", { name: "Use a different account" }).click();
  await expect(page.getByLabel("Email")).toBeVisible();
});

test("tells a member without an organizer how to get one", async ({ page }, info) => {
  await freshAddress(page);
  const email = account("new", info);
  await page.goto("/en/sign-in");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("textbox", { name: "Sign-in code" }).fill(await codeFor(email));
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("You are not part of an organizer yet.")).toBeVisible();
});

test("a page without a language gets one", async ({ page }) => {
  await freshAddress(page);
  await page.goto("/sign-in");
  await expect(page).toHaveURL(/\/en\/sign-in$/);
});
