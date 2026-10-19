import { readFileSync } from "node:fs";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { CODES_FILE } from "#e2e/paths.ts";

let addressCounter = 0;

/** Each test gets its own client address, so the API's per-address throttles never cross tests. */
async function freshAddress(page: Page): Promise<void> {
  addressCounter += 1;
  await page.setExtraHTTPHeaders({ "x-forwarded-for": `198.51.100.${addressCounter}` });
}

/** The account for this test and browser size (created by apps/api/test/e2e-server.ts). */
const account = (name: string, info: TestInfo): string => `${name}.${info.project.name}@najd.test`;

const PASSWORD = "correct horse battery staple";

function readCode(email: string): string | undefined {
  try {
    return (JSON.parse(readFileSync(CODES_FILE, "utf8")) as Record<string, string>)[email];
  } catch {
    return undefined;
  }
}

/** The code emailed to this address, waiting for the API to send it (it answers before the email goes out). */
async function codeFor(email: string): Promise<string> {
  await expect.poll(() => readCode(email), { timeout: 10_000 }).toMatch(/^[0-9]{6}$/);
  return readCode(email) ?? "";
}

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

    await page.getByRole("button", { name: "تسجيل الخروج" }).click();
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

  await page.getByRole("link", { name: "العربية" }).click();
  await expect(page).toHaveURL(/\/ar$/);
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByText("Najd Events")).toBeVisible();
});

test("signs in with the keyboard alone", async ({ page }, info) => {
  await freshAddress(page);
  const email = account("keys", info);
  await page.goto("/en/sign-in");
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
