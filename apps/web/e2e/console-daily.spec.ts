import { expect, test, type Page } from "@playwright/test";
import { openBuilder } from "#e2e/builder.ts";
import { openMenu } from "#e2e/nav.ts";
import { CONTROL_PORT } from "#e2e/paths.ts";

const CONTROL = `http://127.0.0.1:${CONTROL_PORT}`;

/**
 * The console's daily content (T-406c, FR-732, FR-1733, FR-1811, FR-1814). The database is shared by the desktop and
 * phone runs, so each run uses its own words and takes the next free period; the cadence test puts the cadence back
 * where it found it. Content here is never started (the current period is already frozen), so every step is allowed.
 */

async function expectNoSidewaysScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

async function asAdmin(page: Page, project: string): Promise<void> {
  await openBuilder(page, project);
  const eventId = page.url().split("/").at(-2) ?? "";
  expect((await page.request.post(`${CONTROL}/make-admin`, { data: { eventId } })).status()).toBe(
    204,
  );
}

/** Adds a bank question in Arabic: two options, the first one right. */
async function addQuestion(page: Page, prompt: string): Promise<void> {
  await page.getByRole("button", { name: "سؤال جديد" }).click();
  await page.getByLabel("السؤال بالعربية", { exact: true }).fill(prompt);
  await page.getByLabel("السؤال بالإنجليزية", { exact: true }).fill(`${prompt} (en)`);
  await page.getByLabel("الخيار 1 بالعربية", { exact: true }).fill("الرياض");
  await page.getByLabel("الخيار 1 بالإنجليزية", { exact: true }).fill("Riyadh");
  await page.getByLabel("الخيار 2 بالعربية", { exact: true }).fill("جدة");
  await page.getByLabel("الخيار 2 بالإنجليزية", { exact: true }).fill("Jeddah");
  await page.getByRole("button", { name: "احفظ السؤال" }).click();
  await expect(page.getByText("حُفظ السؤال.")).toBeVisible();
}

test("an admin fills the bank, schedules a sponsored challenge and sees the warning and the badge", async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  await asAdmin(page, info.project.name);
  const tag = `${info.project.name}-${Date.now()}`;

  // Nothing is scheduled, so the console home marks Content.
  await page.goto("/ar/console");
  await expect(page.getByTestId("content-badge")).toHaveText("يحتاج إلى انتباه");
  await openMenu(page);
  await page.locator('a[href$="/console/content"]').click();
  await expect(page.getByRole("heading", { name: "المحتوى", level: 1 })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByTestId("daily-warning").first()).toContainText(
    "أسئلة التحدي المجدولة أقل من المطلوب",
  );
  await expect(page.getByTestId("daily-period").first()).toContainText("لا تحدي في هذا الأسبوع.");
  // The current week has started: it offers no action at all.
  await expect(page.getByTestId("daily-period").first()).toContainText("بدأ");
  await expect(page.getByTestId("daily-period").first().getByRole("button")).toHaveCount(0);
  await expectNoSidewaysScroll(page);

  // A question that is not complete is named before anything is sent.
  await page.getByRole("button", { name: "سؤال جديد" }).click();
  await page.getByRole("button", { name: "احفظ السؤال" }).click();
  await expect(
    page.getByText("اكتب السؤال بالعربية والإنجليزية، حتى 300 حرف لكل لغة."),
  ).toBeVisible();
  await page.getByRole("button", { name: "إلغاء", exact: true }).click();

  const prompts = [`سؤال ${tag} 1`, `سؤال ${tag} 2`, `سؤال ${tag} 3`, `سؤال ${tag} 4`];
  for (const prompt of prompts) {
    await addQuestion(page, prompt);
  }
  const bank = page.getByTestId("daily-question");
  await expect(bank.filter({ hasText: prompts[0] ?? "" })).toContainText("(الإجابة الصحيحة)");
  await expectNoSidewaysScroll(page);

  // Retiring asks first, and is for good.
  const spare = bank.filter({ hasText: prompts[3] ?? "" });
  await spare.getByRole("button", { name: "أوقف السؤال" }).click();
  await expect(page.getByRole("alertdialog")).toContainText("إيقاف السؤال نهائيًا؟");
  await page.getByRole("alertdialog").getByRole("button", { name: "أوقف السؤال" }).click();
  await expect(page.getByText("أُوقف السؤال.")).toBeVisible();
  await expect(spare.getByText("متوقف", { exact: true })).toBeVisible();
  await expect(spare.getByRole("button", { name: "عدّل" })).toHaveCount(0);

  // The next free period: three questions, a sponsor in both languages, a preview.
  const period = page
    .getByTestId("daily-period")
    .filter({ has: page.getByRole("button", { name: "اختر الأسئلة" }) })
    .first();
  await period.getByRole("button", { name: "اختر الأسئلة" }).click();
  const editor = page.getByTestId("daily-challenge-editor");
  for (const [index, prompt] of prompts.slice(0, 3).entries()) {
    await editor.getByLabel(`السؤال ${String(index + 1)}`).selectOption(prompt);
  }
  await editor.getByLabel("اسم الراعي بالعربية (اختياري)").fill("شركة النخيل");
  await page.getByRole("button", { name: "احفظ التحدي" }).click();
  await expect(
    page.getByText("اكتب اسم الراعي بالعربية والإنجليزية، حتى 60 حرفًا، أو اترك الحقلين فارغين."),
  ).toBeVisible();
  await editor.getByLabel("اسم الراعي بالإنجليزية (اختياري)").fill("Palm Co");
  await expect(page.getByTestId("daily-preview")).toContainText("برعاية شركة النخيل");
  await expect(page.getByTestId("daily-preview")).toContainText("Presented by Palm Co");
  await expect(page.getByTestId("daily-preview")).toContainText("(الإجابة الصحيحة)");
  await expectNoSidewaysScroll(page);
  await page.getByRole("button", { name: "احفظ التحدي" }).click();
  await expect(page.getByText("حُفظ التحدي.")).toBeVisible();
  const saved = page.getByTestId("daily-period").filter({ hasText: prompts[0] ?? "" });
  await expect(saved).toContainText("الراعي: شركة النخيل");
  await expect(bank.filter({ hasText: prompts[0] ?? "" })).toContainText("مجدول في");

  // One period is not enough cover: the warning stays.
  await expect(page.getByTestId("daily-warning").first()).toBeVisible();
});

test("the challenge period changes from tomorrow, and asking for the current one drops the change", async ({
  page,
}, info) => {
  await asAdmin(page, info.project.name);
  await page.goto("/ar/console/content");
  const control = page.getByLabel("مدة تحدي اليوم");
  await expect(control).toHaveValue("weekly");
  await control.selectOption({ label: "يوم واحد" });
  await page.getByRole("button", { name: "غيّر المدة من الغد" }).click();
  await expect(page.getByText(/حُفظ التغيير\. يسري من/)).toBeVisible();
  await expect(page.getByTestId("daily-cadence-pending")).toContainText("يوم واحد");

  await control.selectOption({ label: "أسبوع من الأحد إلى السبت" });
  await page.getByRole("button", { name: "غيّر المدة من الغد" }).click();
  await expect(page.getByText("هذه هي المدة الحالية. لم يتغيّر شيء.")).toBeVisible();
  await expect(page.getByTestId("daily-cadence-pending")).toHaveCount(0);
});

const WORDS = {
  desktop: { en: "alpha", ar: "مكتبة", list: ["audio", "tales", "stare"], prefix: "aud" },
  phone: { en: "omega", ar: "حديقة", list: ["raise", "adieu", "miles"], prefix: "rai" },
} as const;

test("in English an admin sets the daily words, imports a guess list and searches it", async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  const mine = info.project.name === "phone" ? WORDS.phone : WORDS.desktop;
  await asAdmin(page, info.project.name);
  await page.goto("/en/console/content");
  await page.getByRole("button", { name: /Word bank/ }).click();
  await expect(page.getByTestId("daily-warning")).toHaveCount(2);
  await expect(page.getByTestId("daily-warning").first()).toContainText("Daily words in Arabic");
  await expect(page.getByTestId("daily-warning").nth(1)).toContainText("Daily words in English");

  // The current period has started: it offers no action at all.
  await expect(page.getByTestId("daily-word-period").first()).toContainText("Started");
  await expect(page.getByTestId("daily-word-period").first().getByRole("button")).toHaveCount(0);

  const free = page
    .getByTestId("daily-word-period")
    .filter({ has: page.getByRole("button", { name: "Set the word" }) })
    .first();
  // The period is found again by its dates once it no longer has a free row.
  const dates = (await free.locator("strong").first().textContent()) ?? "";
  const period = page.getByTestId("daily-word-period").filter({ hasText: dates });
  // A word of the wrong length is named before anything is sent.
  await period.getByTestId("daily-word-ar").getByRole("button", { name: "Set the word" }).click();
  await page.getByLabel("Arabic word (5 letters)").fill("كتب");
  await page.getByRole("button", { name: "Save word" }).click();
  await expect(page.getByText("A daily word is exactly 5 letters of its language.")).toBeVisible();
  await page.getByLabel("Arabic word (5 letters)").fill(mine.ar);
  await page.getByRole("button", { name: "Save word" }).click();
  await expect(page.getByText("Word saved.")).toBeVisible();
  await expect(period.getByTestId("daily-word-ar")).toContainText(mine.ar);
  await period.getByTestId("daily-word-en").getByRole("button", { name: "Set the word" }).click();
  await page.getByLabel("English word (5 letters)").fill(mine.en);
  await page.getByRole("button", { name: "Save word" }).click();
  await expect(period.getByTestId("daily-word-en")).toContainText(mine.en);
  await expectNoSidewaysScroll(page);

  // A word is a daily word once: the same English word in another period is refused in words.
  await page
    .getByTestId("daily-word-period")
    .filter({ has: page.getByRole("button", { name: "Set the word" }) })
    .filter({ hasNotText: dates })
    .first()
    .getByTestId("daily-word-en")
    .getByRole("button", { name: "Set the word" })
    .click();
  await page.getByLabel("English word (5 letters)").fill(mine.en);
  await page.getByRole("button", { name: "Save word" }).click();
  await expect(
    page.getByText("That word was already a daily word. A word is used once."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();

  // Remove asks first and says it is for good; after it the word can be set again.
  await period.getByTestId("daily-word-ar").getByRole("button", { name: "Remove" }).click();
  await expect(page.getByRole("alertdialog")).toContainText("Delete for good?");
  await expect(page.getByRole("alertdialog")).toContainText("This is deleted for good.");
  await page.getByRole("alertdialog").getByRole("button", { name: "Cancel" }).click();
  await expect(period.getByTestId("daily-word-ar")).toContainText(mine.ar);
  await period.getByTestId("daily-word-ar").getByRole("button", { name: "Remove" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Remove" }).click();
  await expect(page.getByText("Removed from the schedule.")).toBeVisible();
  await expect(period.getByTestId("daily-word-ar")).toContainText("No word");
  await period.getByTestId("daily-word-ar").getByRole("button", { name: "Set the word" }).click();
  await page.getByLabel("Arabic word (5 letters)").fill(mine.ar);
  await page.getByRole("button", { name: "Save word" }).click();
  await expect(period.getByTestId("daily-word-ar")).toContainText(mine.ar);

  // Import: the lines that are not five letters are shown back, the others join the list.
  const [first, second, third] = mine.list;
  await page
    .getByLabel("Words (5 letters, one per line)")
    .fill(`${first}\n${second}\n${third}\nbad\nab1cd\n\n${first}`);
  await expect(page.getByText("Lines ready to send: 5")).toBeVisible();
  await page.getByRole("button", { name: "Add to list" }).click();
  const result = page.getByTestId("word-import-result");
  await expect(result).toContainText("Added: 3. Removed: 0.");
  await expect(page.getByTestId("word-import-refused")).toContainText("bad");
  await expect(page.getByTestId("word-import-refused")).toContainText("ab1cd");
  await expect(page.getByTestId("word-list-count")).toBeVisible();
  await expectNoSidewaysScroll(page);

  await page.getByLabel("Starts with").fill(mine.prefix);
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.getByText("Matches: 1")).toBeVisible();
  await expect(page.getByTestId("word-list-words")).toContainText(mine.list[0]);

  await page.getByLabel("Words (5 letters, one per line)").fill(mine.list[0]);
  await page.getByRole("button", { name: "Remove from list" }).click();
  await expect(result).toContainText("Removed: 1");
  await expect(page.getByText("No matching words.")).toBeVisible();
});

test("an organizer who is not a Questify admin does not find the page", async ({ page }, info) => {
  await openBuilder(page, info.project.name);
  const response = await page.goto("/ar/console/content");
  expect(response?.status()).toBe(404);
});
