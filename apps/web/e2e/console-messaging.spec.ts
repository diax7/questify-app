import { expect, test, type Page } from "@playwright/test";
import { openBuilder } from "#e2e/builder.ts";
import { CONTROL_PORT } from "#e2e/paths.ts";

const CONTROL = `http://127.0.0.1:${CONTROL_PORT}`;

/**
 * The console's message templates and support contact (T-706, FR-1780, FR-1731), desktop and phone, English and Arabic.
 * The contact is one row shared by the runs, so every project saves the same details.
 */
async function asAdmin(page: Page, project: string): Promise<void> {
  await openBuilder(page, project);
  const eventId = page.url().split("/").at(-2) ?? "";
  expect((await page.request.post(`${CONTROL}/make-admin`, { data: { eventId } })).status()).toBe(
    204,
  );
}

async function expectNoSidewaysScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

test("in English a promotional SMS without the stop-offers link cannot be saved, and one with it can", async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  await asAdmin(page, info.project.name);
  await page.goto("/en/console/messages");
  await expect(page.getByRole("heading", { name: "Messages and contact", level: 1 })).toBeVisible();
  await expect(page.getByTestId("template-card")).toHaveCount(4);

  const card = page.locator('[data-testid="template-card"][data-id="promo_sms"]');
  await expect(card.getByTestId("sms-parts")).toBeVisible();
  await card.getByRole("button", { name: "Edit Promotional SMS" }).click();
  const english = card.getByLabel("Text · English");
  await english.fill("Questify: a new offer for you.");
  await expect(card.getByText("A required placeholder is missing")).toBeVisible();
  await expect(card.getByRole("button", { name: "Save" })).toBeDisabled();

  await english.fill("Questify: a new offer for you.\nStop offers: {optOutUrl}");
  await expect(card.getByText("A required placeholder is missing")).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Save" })).toBeEnabled();
  await card.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Change saved.")).toBeVisible();
  await expect(card.getByText("a new offer for you.", { exact: false })).toBeVisible();
  await expectNoSidewaysScroll(page);

  await card.getByRole("button", { name: "Go back on the last change to Promotional SMS" }).click();
  await expect(page.getByText("Went back to the earlier version.")).toBeVisible();
});

test("in Arabic the support contact is saved and the contact page shows only what is set", async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  await asAdmin(page, info.project.name);
  await page.goto("/ar/console/messages");
  await expect(page.getByRole("heading", { name: "الرسائل والتواصل", level: 1 })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await page.getByRole("button", { name: "بيانات الدعم" }).click();

  const form = page.getByTestId("contact-form");
  await form.getByLabel("رقم واتساب", { exact: false }).fill("0501234567");
  await expect(form.getByText("اكتب الرقم بالصيغة الدولية")).toBeVisible();
  await expect(form.getByRole("button", { name: "حفظ" })).toBeDisabled();
  await form.getByLabel("رقم واتساب", { exact: false }).fill("+966501234567");
  await form.getByLabel("رقم الهاتف", { exact: false }).fill("");
  await form.getByLabel("البريد الإلكتروني").fill(`help-${info.project.name}@questify.sa`);
  await form.getByRole("button", { name: "حفظ" }).click();
  await expect(page.getByText("حُفظ التغيير.")).toBeVisible();

  await page.goto("/ar/contact");
  const ways = page.getByTestId("contact-ways");
  await expect(ways.getByRole("link", { name: "+966501234567" })).toHaveAttribute(
    "href",
    "https://wa.me/966501234567",
  );
  await expect(
    ways.getByRole("link", { name: `help-${info.project.name}@questify.sa` }),
  ).toHaveAttribute("href", `mailto:help-${info.project.name}@questify.sa`);
  await expect(ways.getByText("الهاتف")).toHaveCount(0);
  await expectNoSidewaysScroll(page);
  await page.goto("/en/legal/privacy_policy");
  await expect(page.getByText(`help-${info.project.name}@questify.sa`).first()).toBeVisible();
});
