import { expect, test } from "@playwright/test";
import { codeFor, freshAddress } from "#e2e/mail.ts";
import { CONTROL_PORT } from "#e2e/paths.ts";

test("deletes an account from the web page with a code sent to its email, no app needed", async ({
  page,
  request,
}, info) => {
  await freshAddress(page);
  const tag = `${info.project.name.slice(0, 2)}${Date.now() % 1_000_000}`;
  const email = `leaving.${tag}@najd.test`;
  const made = await request.post(`http://127.0.0.1:${CONTROL_PORT}/account`, {
    data: { usernames: [`leaving_${tag}`], email },
  });
  expect(made.status()).toBe(204);

  await page.goto("/en/delete-account");
  await expect(page.getByRole("heading", { name: "Delete account", level: 1 })).toBeVisible();
  await expect(page.getByText("one-way fingerprint")).toBeVisible();
  await page.getByRole("radio", { name: "Email" }).check();
  await page.getByRole("textbox", { name: "Email" }).fill(email);
  await page.getByRole("button", { name: "Send a confirmation code" }).click();
  await expect(page.getByRole("status")).toContainText(
    "If an account uses this phone number or email",
  );

  await page.getByRole("textbox", { name: "Code" }).fill("000000");
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "That code is not correct." }),
  ).toBeVisible();
  await page.getByRole("textbox", { name: "Code" }).fill(await codeFor(email));
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByRole("heading", { name: "Delete your account for good?" })).toBeVisible();
  await page.getByRole("button", { name: "Delete my account" }).click();
  await expect(page.getByRole("status")).toHaveText("Your account is deleted.");
});

test("answers an unknown contact like a known one, in Arabic and right to left", async ({
  page,
}) => {
  await freshAddress(page);
  await page.goto("/ar/delete-account");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByRole("heading", { name: "حذف الحساب", level: 1 })).toBeVisible();
  await page.getByRole("textbox", { name: "رقم الجوال" }).fill("0551234567");
  await page.getByRole("button", { name: "أرسل رمز التأكيد" }).click();
  await expect(page.getByRole("status")).toContainText("إن كان هذا الرقم أو البريد مسجّلًا في حساب");
});
