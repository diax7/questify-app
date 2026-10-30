import { expect, test } from "@playwright/test";
import { openBuilder } from "#e2e/builder.ts";

/**
 * NFC tags on the dashboard (T-308), in Arabic: a scan quest with its NFC tag ticked keeps its QR ticked and locked
 * with the backup hint, saves, and its edit form shows the Tags panel, empty until an operator writes a tag from the
 * app. A tag tapped outside the app lands on a page that says to tap it from the scanner, in either language.
 */
test("ticks an NFC tag beside the QR and shows the quest's Tags panel", async ({ page }, info) => {
  test.setTimeout(60_000);
  await openBuilder(page, info.project.name);
  await page.getByRole("button", { name: "إضافة مهمة" }).click();
  await page.getByLabel("العنوان بالعربية", { exact: true }).fill("بوابة البرج");
  const qr = page.getByLabel("يمسح اللاعب رمز مهمة");
  await qr.uncheck();
  await page.getByLabel("يمسح المشغّل رمز اللاعب").check();
  await page.getByLabel("يلمس اللاعب بطاقة NFC لمهمة").check();
  await expect(qr).toBeChecked();
  await expect(qr).toBeDisabled();
  await expect(page.getByText("يبقى رمز QR مفعّلًا احتياطًا.")).toBeVisible();
  await page.getByRole("button", { name: "إنشاء مهمة" }).click();

  const quest = page.getByRole("listitem").filter({ hasText: "بوابة البرج" });
  await quest.getByRole("button", { name: "تعديل" }).click();
  const tags = page.getByRole("region", { name: "بطاقات NFC" });
  await expect(tags).toContainText("بطاقة أساسية: يمكن نسخها مثل رمز QR المطبوع.");
  await expect(tags).toContainText("لا بطاقات بعد. يكتبها المشغّلون من وضع الطاقم في التطبيق.");
  await expect(tags.getByRole("button", { name: "إلغاء كل البطاقات" })).toHaveCount(0);
});

test("a tag tapped outside the app lands on a page that says to tap it from the app", async ({
  page,
}) => {
  page.on("pageerror", (error) => {
    throw error;
  });
  const token = Buffer.concat([Buffer.from([0x06]), Buffer.alloc(36, 9)]).toString("base64url");
  await page.goto(`/t/${token}`);
  await expect(page).toHaveURL(new RegExp(`/(ar|en)/t/${token}$`));
  await page.goto(`/ar/t/${token}`);
  await expect(page.getByRole("heading", { name: "بطاقة كويستفاي" })).toBeVisible();
  await expect(page.getByText("المس هذه البطاقة من الماسح داخل تطبيق كويستفاي.")).toBeVisible();
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
  await page.getByRole("link", { name: "التبديل إلى English" }).click();
  await expect(page.getByRole("heading", { name: "A Questify tag" })).toBeVisible();
});
