import { expect, test, type Page } from "@playwright/test";
import { codeFor, freshAddress } from "#e2e/mail.ts";

/**
 * The event's Day streak panel (T-405b), in English and in Arabic, on desktop and phone: the owner of a three-day event
 * turns the streak on, sets a bonus, closes a weekday and a date, saves, and finds it all again after a reload; a bad
 * bonus and a date outside the event are refused in words. The single-day wording and the editor's note are in
 * organizers.spec.ts.
 */

const PASSWORD = "an organizer's own pass phrase";

const WORDS = {
  en: {
    path: "events",
    newEvent: "New event",
    name: "Name in English",
    starts: "Starts",
    ends: "Ends",
    create: "Create event",
    title: "Day streak",
    enable: "Run a day streak in the event",
    bonus: /^Daily bonus/,
    friday: "Friday",
    date: "Date of a closed day",
    add: "Add the date",
    save: "Save the streak settings",
    saved: "The streak settings are saved.",
    preview: /Preview: players see their streak, and their first quest each day pays \+25 points/,
    badBonus: "The bonus is a whole number from 1 to 100,000, or leave it empty.",
    badDate: "A closed date must be one of the event's days.",
    dir: "ltr",
  },
  ar: {
    path: "الفعاليات",
    newEvent: "فعالية جديدة",
    name: "الاسم بالعربية",
    starts: "تبدأ",
    ends: "تنتهي",
    create: "إنشاء الفعالية",
    title: "سلسلة الأيام",
    enable: "تشغيل سلسلة الأيام في الفعالية",
    bonus: /^المكافأة اليومية/,
    friday: "الجمعة",
    date: "تاريخ يوم مغلق",
    add: "أضف التاريخ",
    save: "احفظ إعدادات السلسلة",
    saved: "حُفظت إعدادات السلسلة.",
    preview: /على نقاط: ‎\+25/,
    badBonus: "المكافأة عدد صحيح من 1 إلى 100,000، أو اتركها فارغة.",
    badDate: "تاريخ الإغلاق يجب أن يكون أحد أيام الفعالية.",
    dir: "rtl",
  },
} as const;

async function expectNoSidewaysScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

/** Signs up a new organizer and creates a three-day draft event, then stays on its page in this language. */
async function openThreeDayEvent(page: Page, project: string, language: "en" | "ar") {
  const words = WORDS[language];
  const email = `streak.${project}.${Date.now()}.${Math.floor(Math.random() * 1e6)}@riyadh.test`;
  await freshAddress(page);
  await page.goto("/en/sign-up");
  await page.getByLabel("Organizer name").fill("Najd Streak Co");
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
  if (language === "ar") {
    await page.goto(page.url().replace(/\/en$/, "/ar"));
  }
  await page.getByRole("link", { name: words.path }).click();
  await page.getByRole("link", { name: words.newEvent }).click();
  await page.getByLabel(words.name, { exact: true }).fill("Streak Rally");
  await page.getByLabel(words.starts, { exact: true }).fill("2030-11-01T09:00");
  await page.getByLabel(words.ends, { exact: true }).fill("2030-11-03T17:00");
  await page.getByRole("button", { name: words.create }).click();
  await expect(page.getByRole("heading", { name: words.title })).toBeVisible();
}

for (const language of ["en", "ar"] as const) {
  test(`saves the event's streak settings and reads them back (${language})`, async ({
    page,
  }, info) => {
    test.setTimeout(120_000);
    page.on("pageerror", (error) => {
      throw error;
    });
    const words = WORDS[language];
    await openThreeDayEvent(page, info.project.name, language);
    await expect(page.locator("html")).toHaveAttribute("dir", words.dir);
    const panel = page.getByRole("region", { name: words.title });

    await panel.getByRole("checkbox", { name: words.enable }).check();
    await panel.getByLabel(words.bonus).fill("25");
    await panel.getByRole("checkbox", { name: words.friday }).check();
    await panel.getByLabel(words.date).fill("2030-11-02");
    await panel.getByRole("button", { name: words.add }).click();
    await expect(panel.getByText("2030-11-02", { exact: true })).toBeVisible();
    await expect(panel.getByText(words.preview)).toBeVisible();
    await expectNoSidewaysScroll(page);

    await panel.getByRole("button", { name: words.save }).click();
    await expect(panel.getByText(words.saved)).toBeVisible();

    await page.reload();
    const again = page.getByRole("region", { name: words.title });
    await expect(again.getByRole("checkbox", { name: words.enable })).toBeChecked();
    await expect(again.getByLabel(words.bonus)).toHaveValue("25");
    await expect(again.getByRole("checkbox", { name: words.friday })).toBeChecked();
    await expect(again.getByText("2030-11-02", { exact: true })).toBeVisible();

    await again.getByLabel(words.bonus).fill("0");
    await again.getByRole("button", { name: words.save }).click();
    await expect(again.getByRole("alert")).toHaveText(words.badBonus);

    await again.getByLabel(words.bonus).fill("25");
    await again.getByLabel(words.date).fill("2030-12-25");
    await again.getByRole("button", { name: words.add }).click();
    await again.getByRole("button", { name: words.save }).click();
    await expect(again.getByRole("alert")).toHaveText(words.badDate);
    await expectNoSidewaysScroll(page);
  });
}
