import { expect, test } from "@playwright/test";
import { openBuilder } from "#e2e/builder.ts";

test("prints a QR quest's code, and a new code replaces the printed one after a confirmation", async ({
  page,
}, info) => {
  test.setTimeout(90_000);
  await openBuilder(page, info.project.name);
  await page.getByRole("button", { name: "إضافة مهمة" }).click();
  await page.getByLabel("العنوان بالعربية", { exact: true }).fill("ابحث عن المسرح");
  await page.getByRole("button", { name: "إنشاء مهمة" }).click();
  await page.getByRole("link", { name: "طباعة QR" }).click();

  await expect(page.getByRole("heading", { name: "رموز QR للطباعة", level: 1 })).toBeVisible();
  const code = page.getByRole("img", { name: "رمز QR، مهمة: «ابحث عن المسرح»" });
  await expect(code).toBeVisible();
  // Print QR lands on its card, though the cards arrive after the first paint.
  await expect(code).toBeInViewport();
  await page.emulateMedia({ media: "print" });
  await expect(page.getByRole("button", { name: "رمز جديد" })).toBeHidden();
  await expect(code).toBeVisible();
  await page.emulateMedia({ media: "screen" });
  // Right to left never mirrors a code: a mirrored code does not scan.
  expect(await code.evaluate((svg) => getComputedStyle(svg).transform)).toBe("none");
  await expect(page.getByText("النسخة 1")).toBeVisible();
  const before = await code.locator("path").getAttribute("d");

  await page.getByRole("button", { name: "رمز جديد" }).click();
  await expect(page.getByRole("heading", { name: "إنشاء رمز جديد؟" })).toBeFocused();
  await page.getByRole("alertdialog").getByRole("button", { name: "رمز جديد" }).click();
  await expect(
    page.getByText("أنشأنا رمزًا جديدًا. الرمز القديم لم يعد يعمل. اطبعه مجددًا."),
  ).toBeVisible();
  await expect(page.getByText("النسخة 2")).toBeVisible();
  expect(await code.locator("path").getAttribute("d")).not.toBe(before);
});

test("a code scanned by a phone camera lands on a page that says to use the app, in either language", async ({
  page,
}) => {
  page.on("pageerror", (error) => {
    throw error;
  });
  const token = "A".repeat(50);
  await page.goto(`/q/${token}`);
  await expect(page).toHaveURL(new RegExp(`/(ar|en)/q/${token}$`));
  await page.goto(`/ar/q/${token}`);
  await expect(
    page.getByRole("heading", { name: "امسح هذا الرمز من تطبيق Questify" }),
  ).toBeVisible();
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
  await page.getByRole("link", { name: "التبديل إلى English" }).click();
  await expect(
    page.getByRole("heading", { name: "Scan this code in the Questify app" }),
  ).toBeVisible();
});

test("a hidden category's secret code opens the same page, naming nothing (T-304c)", async ({
  page,
}) => {
  page.on("pageerror", (error) => {
    throw error;
  });
  // The secret code's layout (format 0x05): the page never reads or checks it, so any bytes after the format do.
  const token = Buffer.concat([Buffer.from([0x05]), Buffer.alloc(36, 9)]).toString("base64url");
  await page.goto(`/ar/q/${token}`);
  await expect(
    page.getByRole("heading", { name: "امسح هذا الرمز من تطبيق Questify" }),
  ).toBeVisible();
  await expect(page.getByRole("main")).not.toContainText("فئة");
});
