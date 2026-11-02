import { expect, test, type Page } from "@playwright/test";
import { openBuilder } from "#e2e/builder.ts";
import { CONTROL_PORT } from "#e2e/paths.ts";

const CONTROL = `http://127.0.0.1:${CONTROL_PORT}`;

/**
 * The console's legal documents and help articles (T-707, FR-1781, FR-1782), desktop and phone, English and Arabic. Only
 * the player documents are published here: a new organizer document would hold every organizer the other specs made. The
 * database is shared by the runs, so each project publishes its own, later version (seconds since the epoch) and writes its
 * own help article.
 */
const ARTICLE = { desktop: "e2e-desktop", phone: "e2e-phone" } as const;
const articleOf = (project: string) => (project === "phone" ? ARTICLE.phone : ARTICLE.desktop);

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

test("in English a new version of the guidelines is published, in force at once, and a lower one is refused", async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  await asAdmin(page, info.project.name);
  await page.goto("/en/console/legal");
  await expect(page.getByRole("heading", { name: "Legal and help", level: 1 })).toBeVisible();
  await expect(page.getByTestId("legal-card")).toHaveCount(6);

  const now = new Date();
  const version = [
    (now.getUTCFullYear() - 2000) * 100 + now.getUTCMonth() + 1,
    now.getUTCDate() * 100 + now.getUTCHours(),
    now.getUTCMinutes() * 100 + now.getUTCSeconds(),
  ].join(".");
  const card = page.locator('[data-testid="legal-card"][data-id="community_guidelines"]');
  await card.getByRole("button", { name: "New version of Community guidelines" }).click();
  await card.getByLabel("Version number").fill("v1");
  await expect(card.getByText("can't be saved")).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Publish version" })).toBeDisabled();
  await card.getByLabel("Version number").fill(version);
  await card.getByLabel("Arabic text").fill("## إرشادات المجتمع\n\nكن لطيفًا.");
  await card.getByLabel("English text").fill("## Community guidelines\n\nBe kind.");
  await card.getByRole("button", { name: "Publish version" }).click();
  await card.getByRole("button", { name: "Publish version" }).click();
  await expect(page.getByText(`Version ${version} is published and in force.`)).toBeVisible();
  await expect(card.getByText(`In force: ${version}`)).toBeVisible();
  await expect(card.getByTestId("legal-version").first()).toContainText(`v${version}`);

  await page.goto("/en/legal/community_guidelines");
  await expect(page.getByText(`v${version}`)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Community guidelines" })).toBeVisible();
  await expect(page.getByText("Be kind.")).toBeVisible();
  await page.goto("/ar/legal/community_guidelines");
  await expect(page.getByText("كن لطيفًا.")).toBeVisible();

  await page.goto("/en/console/legal");
  const again = page.locator('[data-testid="legal-card"][data-id="community_guidelines"]');
  await again.getByRole("button", { name: "New version of Community guidelines" }).click();
  await again.getByLabel("Version number").fill("1");
  await again.getByLabel("Arabic text").fill("نص");
  await again.getByLabel("English text").fill("Text");
  await again.getByRole("button", { name: "Publish version" }).click();
  await again.getByRole("button", { name: "Publish version" }).click();
  await expect(page.getByText("The version must be later than the one in force.")).toBeVisible();
  await expectNoSidewaysScroll(page);
});

test("in Arabic the help article of one language shows to both readers, marked for the other", async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  const id = articleOf(info.project.name);
  await asAdmin(page, info.project.name);
  await page.goto("/ar/console/legal");
  await expect(page.getByRole("heading", { name: "الوثائق والمساعدة", level: 1 })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await page.getByRole("button", { name: "المساعدة والأسئلة الشائعة" }).click();

  await page.getByRole("button", { name: "مقال جديد" }).click();
  const form = page.getByRole("region", { name: "مقال جديد" });
  await form.getByLabel("المعرّف", { exact: false }).fill(id);
  await form.getByLabel("السؤال · الإنجليزية").fill(`Where is the desk ${id}?`);
  await form.getByLabel("الجواب · الإنجليزية").fill("At the main gate.");
  await expect(form.getByRole("button", { name: "حفظ" })).toBeEnabled();
  await form.getByLabel("يظهر للجميع").check();
  await form.getByRole("button", { name: "حفظ" }).click();
  await expect(page.getByText("حُفظ التغيير.")).toBeVisible();
  const card = page.locator(`[data-testid="help-card"][data-id="${id}"]`);
  await expect(card.getByText("ظاهر")).toBeVisible();

  await page.goto("/ar/help");
  const article = page.getByRole("article").filter({ hasText: `Where is the desk ${id}?` });
  await expect(article).toBeVisible();
  await expect(article.getByText("متاح بالإنجليزية فقط")).toBeVisible();
  await expect(article).toHaveAttribute("dir", "ltr");
  await page.goto("/en/help");
  const english = page.getByRole("article").filter({ hasText: `Where is the desk ${id}?` });
  await expect(english).toBeVisible();
  await expect(english.getByText("Only in English")).toHaveCount(0);
  await expectNoSidewaysScroll(page);

  await page.goto("/ar/console/legal");
  await page.getByRole("button", { name: "المساعدة والأسئلة الشائعة" }).click();
  const row = page.locator(`[data-testid="help-card"][data-id="${id}"]`);
  await row.getByRole("button", { name: /^تعديل / }).click();
  await row.getByLabel("يظهر للجميع").uncheck();
  await row.getByRole("button", { name: "حفظ" }).click();
  await expect(row.getByText("مخفي")).toBeVisible();
  await page.goto("/en/help");
  await expect(page.getByText(`Where is the desk ${id}?`)).toHaveCount(0);
});
