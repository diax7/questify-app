import { expect, test, type Page } from "@playwright/test";
import { openBuilder } from "#e2e/builder.ts";
import { CONTROL_PORT } from "#e2e/paths.ts";

const ORIGIN = "http://localhost:3100";
const CONTROL = `http://127.0.0.1:${CONTROL_PORT}`;

type Setup = { currentStep: number; steps: string[]; finished: boolean; updatedAt: string | null };

/** Reads the event's saved setup as the signed-in organizer, through the web origin. */
async function savedSetup(page: Page, eventUrl: string): Promise<Setup> {
  const ids = /organizers\/([0-9a-f-]{36})\/events\/([0-9a-f-]{36})/.exec(eventUrl);
  const response = await page.request.fetch(`/v1/organizers/${ids?.[1]}/events/${ids?.[2]}/setup`, {
    headers: { origin: ORIGIN },
  });
  expect(response.status()).toBe(200);
  return ((await response.json()) as { setup: Setup }).setup;
}

async function control(page: Page, path: string, data: object): Promise<void> {
  const answer = await page.request.post(`${CONTROL}${path}`, { data });
  expect(answer.status(), await answer.text()).toBeLessThan(300);
}

/** The progress bar of the wizard, which says which of the ten steps is open. */
const stepBar = (page: Page) => page.getByRole("progressbar", { name: "تقدّم الإعداد" });

/**
 * The guided setup, in Arabic (T-605, FR-1751 to FR-1756, FR-1846): the Overview card starts it; a step is decided or
 * skipped and saved as it moves; leaving and coming back opens the same step; the ten steps open from a list; an
 * add-on that is not unlocked cannot be ticked and offers Ask Questify, and shows Open once unlocked; skipping the whole
 * setup asks first and keeps every default; running it again opens the first step.
 */
test("walks the guided setup, resumes at the saved step and keeps the defaults of skipped ones", async ({
  page,
}, info) => {
  test.setTimeout(150_000);
  await openBuilder(page, info.project.name);
  const eventUrl = page.url().replace(/\/quests$/, "");
  const eventId = eventUrl.split("/").at(-1) ?? "";

  await page.goto(eventUrl);
  await expect(page.getByRole("heading", { name: "الإعداد الموجّه", level: 2 })).toBeVisible();
  await page.getByRole("link", { name: "ابدأ الإعداد الموجّه" }).click();
  await expect(page.getByRole("heading", { name: "الإعداد الموجّه", level: 1 })).toBeVisible();
  await expect(stepBar(page)).toHaveAttribute("aria-valuenow", "1");
  await expect(
    page.getByRole("heading", { name: "ما فعاليتك، ومن يمكنه إيجادها؟", level: 2 }),
  ).toBeVisible();

  await page.getByRole("button", { name: "متابعة" }).click();
  await expect(stepBar(page)).toHaveAttribute("aria-valuenow", "2");
  await expect(page.getByRole("heading", { name: "كيف ينضم الحضور؟", level: 2 })).toBeFocused();
  await page.getByRole("button", { name: "تخطّي الخطوة" }).click();
  await expect(stepBar(page)).toHaveAttribute("aria-valuenow", "3");
  const early = await savedSetup(page, eventUrl);
  expect(early).toMatchObject({ currentStep: 3, finished: false });
  expect(early.steps.slice(0, 3)).toEqual(["done", "skipped", "open"]);

  await page.getByRole("button", { name: "كل الخطوات" }).click();
  await expect(page.getByRole("dialog").getByRole("button")).toHaveCount(11);
  await page.getByRole("button", { name: "فتح الشاشات والفريق" }).click();
  await expect(stepBar(page)).toHaveAttribute("aria-valuenow", "6");

  const big = page.getByRole("checkbox", { name: "الشاشة الكبيرة" });
  await expect(big).toBeDisabled();
  await expect(big).not.toBeChecked();
  await expect(page.getByText("متاحة مع إضافة.")).toBeVisible();
  await expect(page.getByRole("link", { name: "اسأل Questify" })).toHaveAttribute(
    "href",
    "/ar/contact",
  );

  await page.goto(`${eventUrl}/setup`);
  await expect(stepBar(page)).toHaveAttribute("aria-valuenow", "6");
  await expect(page.getByRole("checkbox", { name: "الشاشة الكبيرة" })).toBeDisabled();

  await control(page, "/addon", { eventId, feature: "bigScreen" });
  await page.reload();
  await expect(page.getByRole("checkbox", { name: "الشاشة الكبيرة" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "فتح الشاشة الكبيرة" })).toBeVisible();
  await expect(page.getByRole("link", { name: "اسأل Questify" })).toHaveCount(0);

  await page.goto(eventUrl);
  await expect(page.getByText("الخطوة 6 من 10")).toBeVisible();
  await page.getByRole("link", { name: "تابع الإعداد" }).click();
  await expect(stepBar(page)).toHaveAttribute("aria-valuenow", "6");

  await page.getByRole("button", { name: "تخطّي الإعداد الموجّه" }).click();
  const asking = page.getByRole("alertdialog");
  await expect(asking).toContainText("تخطّي الإعداد الموجّه؟");
  await asking.getByRole("button", { name: "إلغاء" }).click();
  expect((await savedSetup(page, eventUrl)).finished).toBe(false);
  await page.getByRole("button", { name: "تخطّي الإعداد الموجّه" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "تخطّي الكل" }).click();
  await expect(page).toHaveURL(eventUrl);
  await expect(page.getByText("انتهى الإعداد.")).toBeVisible();
  const skipped = await savedSetup(page, eventUrl);
  expect(skipped.finished).toBe(true);
  expect(skipped.steps.slice(0, 2)).toEqual(["done", "skipped"]);
  expect(skipped.steps).not.toContain("open");

  await page.getByRole("link", { name: "شغّل الإعداد من جديد" }).click();
  await expect(page).toHaveURL(/\/setup\?step=basics$/);
  await expect(stepBar(page)).toHaveAttribute("aria-valuenow", "1");
  expect((await savedSetup(page, eventUrl)).finished).toBe(true);
  await page.getByRole("button", { name: "متابعة" }).click();
  await expect(stepBar(page)).toHaveAttribute("aria-valuenow", "2");
  expect(await savedSetup(page, eventUrl)).toMatchObject({ finished: false, currentStep: 2 });
});

/**
 * "Explain this" (FR-1756): a Build page opens its step alone, without the progress or the other steps, and Done
 * returns to the page. The interview's saved progress is not touched.
 */
test("opens one step alone from a build page and returns to it", async ({ page }, info) => {
  test.setTimeout(120_000);
  await openBuilder(page, info.project.name);
  const eventUrl = page.url().replace(/\/quests$/, "");

  await page.goto(`${eventUrl}/rewards`);
  await page.getByRole("link", { name: "اشرح لي هذه الصفحة" }).click();
  await expect(page).toHaveURL(/\/setup\?step=rewards&only=1&from=rewards$/);
  await expect(page.getByRole("heading", { name: "الجوائز", level: 1 })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "ماذا يمكن أن يربح الحضور؟", level: 2 }),
  ).toBeVisible();
  await expect(stepBar(page)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "كل الخطوات" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "تخطّي الخطوة" })).toHaveCount(0);
  await page.getByRole("link", { name: "تم" }).click();
  await expect(page).toHaveURL(`${eventUrl}/rewards`);
  expect(await savedSetup(page, eventUrl)).toMatchObject({
    currentStep: 1,
    updatedAt: null,
    finished: false,
  });
});

/**
 * A text a Questify admin changed in the translation store shows in the wizard without a release (FR-1757); a change that
 * drops a placeholder, or a blank one, is ignored and the shipped text stays (FR-1768).
 */
test("shows the text an admin changed and ignores one that is not usable", async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  await openBuilder(page, info.project.name);
  const eventUrl = page.url().replace(/\/quests$/, "");
  await control(page, "/translation", {
    key: "wizard.sponsors.title",
    ar: "من يدعم فعاليتك؟",
    en: "Who backs your event?",
  });
  await control(page, "/translation", { key: "wizard.quests.title", ar: "أي أنواع تختار؟" });

  await expect(async () => {
    await page.goto(`${eventUrl}/setup?step=sponsors`);
    await expect(page.getByRole("heading", { name: "من يدعم فعاليتك؟", level: 2 })).toBeVisible({
      timeout: 4_000,
    });
  }).toPass({ timeout: 40_000 });

  await page.goto(`${eventUrl}/setup?step=quests`);
  await expect(
    page.getByRole("heading", { name: "أي أنواع مهام ستستخدم؟", level: 2 }),
  ).toBeVisible();
});

/**
 * Every step is shown from a fresh read of the event, so going Back to a step shows its switches as they were left
 * (not as the wizard first read them), and a step with edits not yet saved asks before Continue, Skip or Back drop them.
 */
test("shows a step's switches as left after Back and asks before dropping unsaved edits", async ({
  page,
}, info) => {
  test.setTimeout(150_000);
  await openBuilder(page, info.project.name);
  const eventUrl = page.url().replace(/\/quests$/, "");

  await page.goto(`${eventUrl}/setup?step=quests`);
  await expect(stepBar(page)).toHaveAttribute("aria-valuenow", "3");
  const games = page.getByRole("checkbox", { name: "إظهار الألعاب المصغّرة للاعبين" });
  await expect(games).toBeChecked();
  await games.uncheck();
  await expect(games).not.toBeChecked();
  await expect(games).toBeEnabled();
  await page.getByRole("button", { name: "متابعة" }).click();
  await expect(stepBar(page)).toHaveAttribute("aria-valuenow", "4");
  await page.getByRole("button", { name: "رجوع" }).click();
  await expect(stepBar(page)).toHaveAttribute("aria-valuenow", "3");
  await expect(games).not.toBeChecked();

  await page.goto(`${eventUrl}/setup?step=basics`);
  await expect(stepBar(page)).toHaveAttribute("aria-valuenow", "1");
  await page.getByLabel("الاسم بالإنجليزية", { exact: true }).fill("Najd Meetup");
  await page.getByRole("button", { name: "متابعة" }).click();
  const asking = page.getByRole("alertdialog");
  await expect(asking).toContainText("تجاهل التغييرات غير المحفوظة؟");
  await asking.getByRole("button", { name: "إلغاء" }).click();
  await expect(stepBar(page)).toHaveAttribute("aria-valuenow", "1");
  await expect(page.getByLabel("الاسم بالإنجليزية", { exact: true })).toHaveValue("Najd Meetup");

  await page.getByRole("button", { name: "حفظ التغييرات" }).click();
  await expect(page.getByText("حُفظت التغييرات.")).toBeVisible();
  await page.getByRole("button", { name: "متابعة" }).click();
  await expect(stepBar(page)).toHaveAttribute("aria-valuenow", "2");
  await expect(page.getByRole("alertdialog")).toHaveCount(0);

  const guests = page.getByRole("checkbox", { name: "المدعوون في القائمة فقط" });
  await guests.check();
  await page.getByRole("button", { name: "تخطّي الخطوة" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "تجاهل", exact: true }).click();
  await expect(stepBar(page)).toHaveAttribute("aria-valuenow", "3");
  await page.getByRole("button", { name: "رجوع" }).click();
  await expect(stepBar(page)).toHaveAttribute("aria-valuenow", "2");
  await expect(guests).not.toBeChecked();
});

/** The review list of a single-step view opens another step alone and saves nothing (FR-1756). */
test("opens a step from the single-step review without saving progress", async ({ page }, info) => {
  test.setTimeout(120_000);
  await openBuilder(page, info.project.name);
  const eventUrl = page.url().replace(/\/quests$/, "");

  await page.goto(`${eventUrl}/setup?step=review&only=1`);
  await expect(stepBar(page)).toHaveCount(0);
  await page
    .getByRole("button", { name: /^فتح / })
    .first()
    .click();
  await expect(page).toHaveURL(/\/setup\?step=basics&only=1$/);
  await expect(
    page.getByRole("heading", { name: "ما فعاليتك، ومن يمكنه إيجادها؟", level: 2 }),
  ).toBeVisible();
  expect(await savedSetup(page, eventUrl)).toMatchObject({
    currentStep: 1,
    updatedAt: null,
    finished: false,
  });
});
