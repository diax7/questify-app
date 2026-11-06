import { expect, test, type Page } from "@playwright/test";
import { openBuilder } from "#e2e/builder.ts";

/**
 * Event templates (T-601b, FR-1015): the new-event page offers Start blank and the four templates with a preview of what each
 * sets up, an event made from one holds its categories and quests in both languages, and the guided setup's first step starts
 * an empty draft from one after a confirmation. Arabic (right to left) and English, on a phone, without a sideways scroll.
 */

const PHONE = { width: 390, height: 844 };

async function expectNoSidewaysScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

/** The events list of the organizer the builder opened, in the language of the address. */
async function eventsList(page: Page, project: string, language: "ar" | "en"): Promise<string> {
  await openBuilder(page, project);
  const list = page.url().replace(/\/[0-9a-f-]{36}\/quests$/, "");
  return list.replace("/ar/", `/${language}/`);
}

test("the picker starts blank, previews a template, and the event holds its quests in Arabic", async ({
  page,
}, info) => {
  test.setTimeout(180_000);
  const list = await eventsList(page, info.project.name, "ar");
  await page.setViewportSize(PHONE);
  await page.goto(`${list}/new`);
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByRole("heading", { name: "ابدأ من قالب" })).toBeVisible();
  await expect(page.getByRole("radio", { name: "ابدأ فارغًا" })).toBeChecked();
  for (const name of ["مؤتمر", "مهرجان", "فعالية جامعية", "فعالية الشركة"]) {
    await expect(page.getByRole("radio", { name })).toBeVisible();
  }
  await expectNoSidewaysScroll(page);

  await page.getByRole("radio", { name: "مهرجان" }).check();
  const preview = page.getByRole("heading", { name: "ما يجهّزه قالب مهرجان" });
  await expect(preview).toBeVisible();
  await expect(page.getByText("تحدّي الرقص").first()).toBeVisible();
  await expect(page.getByText("جولة خلف الكواليس").first()).toBeVisible();
  await expectNoSidewaysScroll(page);

  await page.getByLabel("الاسم بالعربية", { exact: true }).fill("مهرجان الرياض");
  await page.getByLabel("تبدأ", { exact: true }).fill("2031-03-01T09:00");
  await page.getByLabel("تنتهي", { exact: true }).fill("2031-03-01T17:00");
  await page.getByRole("button", { name: "إنشاء الفعالية" }).click();
  await expect(page).toHaveURL(/\/events\/[0-9a-f-]{36}$/);

  await page.goto(`${page.url()}/quests`);
  await expect(page.getByText("على المسارح").first()).toBeVisible();
  await expect(page.getByText("تحدّي الرقص").first()).toBeVisible();
  await expectNoSidewaysScroll(page);

  await page.goto(page.url().replace("/quests", "/rewards").replace("/ar/", "/en/"));
  await expect(page.getByText("Backstage tour").first()).toBeVisible();
});

test("the same template reads in English, and Start blank still makes an event with no quests", async ({
  page,
}, info) => {
  test.setTimeout(180_000);
  const list = await eventsList(page, info.project.name, "en");
  await page.goto(`${list}/new`);
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  await expect(page.getByRole("radio", { name: "Start blank" })).toBeChecked();

  await page.getByRole("radio", { name: "Conference" }).check();
  await expect(
    page.getByRole("heading", { name: "What the Conference template sets up" }),
  ).toBeVisible();
  await expect(page.getByText("Say hello to a speaker").first()).toBeVisible();
  await page.getByRole("radio", { name: "Start blank" }).check();
  await expect(page.getByRole("heading", { name: /^What the/ })).toHaveCount(0);

  await page.getByRole("radio", { name: "Conference" }).check();
  await page.getByLabel("Name in English", { exact: true }).fill("Tech Conference");
  await page.getByLabel("Starts", { exact: true }).fill("2031-04-01T09:00");
  await page.getByLabel("Ends", { exact: true }).fill("2031-04-01T17:00");
  await page.getByRole("button", { name: "Create event" }).click();
  await expect(page).toHaveURL(/\/events\/[0-9a-f-]{36}$/);
  await page.goto(`${page.url()}/quests`);
  await expect(page.getByText("Start your day").first()).toBeVisible();
  await expect(page.getByText("Check in").first()).toBeVisible();

  await page.goto(`${list}/new`);
  await page.getByLabel("Name in English", { exact: true }).fill("Plain Meetup");
  await page.getByLabel("Starts", { exact: true }).fill("2031-05-01T09:00");
  await page.getByLabel("Ends", { exact: true }).fill("2031-05-01T17:00");
  await page.getByRole("button", { name: "Create event" }).click();
  await expect(page).toHaveURL(/\/events\/[0-9a-f-]{36}$/);
  await page.goto(`${page.url()}/quests`);
  await expect(page.getByText("Check in")).toHaveCount(0);
});

test("the guided setup starts an empty draft from a template after a confirmation", async ({
  page,
}, info) => {
  test.setTimeout(180_000);
  const list = await eventsList(page, info.project.name, "en");
  await page.goto(`${list}/new`);
  await page.getByLabel("Name in English", { exact: true }).fill("Campus Day");
  await page.getByLabel("Starts", { exact: true }).fill("2031-06-01T09:00");
  await page.getByLabel("Ends", { exact: true }).fill("2031-06-01T17:00");
  await page.getByRole("button", { name: "Create event" }).click();
  await expect(page).toHaveURL(/\/events\/[0-9a-f-]{36}$/);
  const event = page.url();

  await page.goto(`${event}/setup`);
  await expect(page.getByRole("heading", { name: "Start from a template" })).toBeVisible();
  const use = page.getByRole("button", { name: "Use this template" });
  await expect(use).toBeDisabled();
  await page.getByRole("radio", { name: "Campus event" }).check();
  await use.click();
  const dialog = page.getByRole("alertdialog", { name: "Apply the Campus event template?" });
  await expect(dialog).toContainText(
    "The template also sets the features it lists, the accent colour and the layout; other features stay as they are.",
  );
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  await use.click();
  await dialog.getByRole("button", { name: "Apply template" }).click();
  await expect(page.getByText("The Campus event template is set up.")).toBeVisible();

  await page.goto(`${event}/quests`);
  await expect(page.getByText("Visit the library").first()).toBeVisible();
  await page.goto(`${event}/setup`);
  await expect(page.getByRole("heading", { name: "Start from a template" })).toHaveCount(0);
});
