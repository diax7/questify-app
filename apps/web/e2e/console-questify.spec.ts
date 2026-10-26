import { expect, test, type Page } from "@playwright/test";
import { openBuilder } from "#e2e/builder.ts";
import { CONTROL_PORT } from "#e2e/paths.ts";

const CONTROL = `http://127.0.0.1:${CONTROL_PORT}`;

/**
 * The console's Questify quests (T-403c, FR-710, FR-711), in Arabic: the seeded always-on quests show; an admin makes
 * a campaign, is told in words why a start in the past cannot be published, moves the start, publishes, adds a quest,
 * is told which field a bad number is, and retires the quest after a confirmation. Desktop and phone.
 */

async function expectNoSidewaysScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

/** A time `days` from now as a date-time field's value (read as Saudi time by the page). */
const inDays = (days: number): string =>
  new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 16);

test("an admin builds a campaign, hears why it cannot publish yet, publishes it and retires a quest", async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  await openBuilder(page, info.project.name);
  const eventId = page.url().split("/").at(-2) ?? "";
  expect((await page.request.post(`${CONTROL}/make-admin`, { data: { eventId } })).status()).toBe(
    204,
  );

  await page.goto("/ar/console");
  await page.getByRole("link", { name: "مهام Questify" }).click();
  await expect(page.getByRole("heading", { name: "مهام Questify", level: 1 })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(
    page.getByTestId("questify-quest").filter({ hasText: "العب في مدينتين" }),
  ).toBeVisible();
  await expect(
    page.getByTestId("questify-quest").filter({ hasText: "شارك في 3 فعاليات" }),
  ).toBeVisible();
  await expectNoSidewaysScroll(page);

  // A seeded quest already pays, so its gems show (25) and can no longer change.
  const seeded = page.getByTestId("questify-quest").filter({ hasText: "شارك في 3 فعاليات" });
  await expect(seeded).toContainText("الجواهر 25");
  await seeded.getByRole("button", { name: "عدّل المهمة" }).click();
  await expect(page.getByLabel("الجواهر (من 0 إلى 1000)")).toBeDisabled();
  await expect(page.getByLabel("الجواهر (من 0 إلى 1000)")).toHaveValue("25");
  await expect(page.getByText("تثبت الجواهر عندما تصبح المهمة قابلة للدفع.")).toBeVisible();
  await expectNoSidewaysScroll(page);
  await page.getByRole("button", { name: "إلغاء", exact: true }).click();

  // A draft may start in the past, but it cannot be published like that.
  await page.getByRole("button", { name: "موسم جديد" }).click();
  const name = `موسم الشتاء ${info.project.name}`;
  await page.getByLabel("اسم الموسم بالعربية", { exact: true }).fill(name);
  await page.getByLabel("اسم الموسم بالإنجليزية", { exact: true }).fill("Winter season");
  await page.getByLabel("يبدأ (بتوقيت السعودية)", { exact: true }).fill(inDays(-2));
  await page.getByLabel("ينتهي (بتوقيت السعودية)", { exact: true }).fill(inDays(30));
  await page.getByRole("button", { name: "احفظ", exact: true }).click();
  await expect(page.getByText("حُفظت التغييرات.")).toBeVisible();
  const campaign = page.getByTestId("questify-campaign").filter({ hasText: name });
  await expect(campaign.getByText("مسودة", { exact: true }).first()).toBeVisible();
  const publishCalls: string[] = [];
  page.on("request", (sent) => {
    if (sent.method() === "POST" && sent.url().endsWith("/publish")) {
      publishCalls.push(sent.url());
    }
  });
  // Publishing asks first: cancel sends nothing, the confirm button sends the one call.
  await campaign.getByRole("button", { name: "انشر الموسم" }).click();
  await expect(page.getByRole("alertdialog")).toContainText("نشر الموسم؟");
  await expect(page.getByRole("alertdialog")).toContainText("لا يمكن التراجع عن النشر.");
  await page.getByRole("alertdialog").getByRole("button", { name: "إلغاء" }).click();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  expect(publishCalls).toHaveLength(0);
  await campaign.getByRole("button", { name: "انشر الموسم" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "انشر الموسم" }).click();
  await expect(
    page.getByText("مضى وقت البداية. اختر وقتًا مستقبليًا ثم انشر.", { exact: true }),
  ).toBeVisible();

  await campaign.getByRole("button", { name: "عدّل الموسم" }).click();
  await page.getByLabel("يبدأ (بتوقيت السعودية)", { exact: true }).fill(inDays(1));
  await page.getByRole("button", { name: "احفظ", exact: true }).click();
  await expect(page.getByText("حُفظت التغييرات.")).toBeVisible();
  await campaign.getByRole("button", { name: "انشر الموسم" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "انشر الموسم" }).click();
  await expect(page.getByText("نُشر الموسم.")).toBeVisible();
  await expect(campaign.getByText("منشور", { exact: true })).toBeVisible();
  expect(publishCalls).toHaveLength(2);

  // A quest for the campaign: a bad target is named before anything is sent.
  await campaign.getByRole("button", { name: "مهمة جديدة" }).click();
  await page.getByLabel("عنوان المهمة بالعربية", { exact: true }).fill("العب في 4 مدن");
  await page.getByLabel("عنوان المهمة بالإنجليزية", { exact: true }).fill("Play in 4 cities");
  await page.getByLabel("ما تحسبه المهمة").selectOption("cities");
  await page.getByLabel("الهدف (من 1 إلى 1000)").fill("0");
  await page.getByLabel("الخبرة (XP، من 1 إلى 10000)").fill("50");
  await page.getByLabel("الجواهر (من 0 إلى 1000)").fill("15");
  await page.getByRole("button", { name: "احفظ", exact: true }).click();
  await expect(page.getByText("الهدف عدد صحيح من 1 إلى 1000.", { exact: true })).toBeVisible();
  await page.getByLabel("الهدف (من 1 إلى 1000)").fill("4");
  await page.getByLabel("الجواهر (من 0 إلى 1000)").fill("1001");
  await page.getByRole("button", { name: "احفظ", exact: true }).click();
  await expect(page.getByText("الجواهر عدد صحيح من 0 إلى 1000.", { exact: true })).toBeVisible();
  await page.getByLabel("الجواهر (من 0 إلى 1000)").fill("15");
  await page.getByRole("button", { name: "احفظ", exact: true }).click();
  await expect(page.getByText("حُفظت التغييرات.")).toBeVisible();
  const quest = campaign.getByTestId("questify-quest").filter({ hasText: "العب في 4 مدن" });
  await expect(quest).toContainText("المدن التي لعب فيها: 4، الخبرة 50، الجواهر 15");
  await expectNoSidewaysScroll(page);

  // Retiring asks first and is permanent.
  await quest.getByRole("button", { name: "أوقف المهمة" }).click();
  await expect(page.getByRole("alertdialog")).toContainText("إيقاف نهائي؟");
  await page.getByRole("alertdialog").getByRole("button", { name: "أوقف المهمة" }).click();
  await expect(page.getByText("أُوقفت المهمة.")).toBeVisible();
  await expect(quest.getByText("متوقفة", { exact: true })).toBeVisible();
  await expect(quest.getByRole("button", { name: "عدّل المهمة" })).toHaveCount(0);
});

test("in English the publish dialog says it cannot be undone and starts paying XP", async ({
  page,
}, info) => {
  await openBuilder(page, info.project.name);
  const eventId = page.url().split("/").at(-2) ?? "";
  expect((await page.request.post(`${CONTROL}/make-admin`, { data: { eventId } })).status()).toBe(
    204,
  );
  await page.goto("/en/console/questify");
  await page.getByRole("button", { name: "New campaign" }).click();
  await page.getByLabel("Campaign name in Arabic", { exact: true }).fill("موسم الربيع");
  await page
    .getByLabel("Campaign name in English", { exact: true })
    .fill(`Spring ${info.project.name}`);
  await page.getByLabel("Starts (Saudi time)", { exact: true }).fill(inDays(1));
  await page.getByLabel("Ends (Saudi time)", { exact: true }).fill(inDays(30));
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const campaign = page
    .getByTestId("questify-campaign")
    .filter({ hasText: `Spring ${info.project.name}` });
  await campaign.getByRole("button", { name: "Publish campaign" }).click();
  await expect(page.getByRole("alertdialog")).toContainText("Publish this campaign?");
  await expect(page.getByRole("alertdialog")).toContainText(
    "Publishing can't be undone. From then on the campaign starts paying XP to players.",
  );
  await page.getByRole("alertdialog").getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);

  // A new quest starts paying no gems, and its gems can be set while it cannot pay yet.
  await campaign.getByRole("button", { name: "New quest" }).click();
  await expect(page.getByLabel("Gems paid (0 to 1000)")).toHaveValue("0");
  await expect(page.getByLabel("Gems paid (0 to 1000)")).toBeEnabled();
});

test("Escape closes the publish dialog, sends nothing, and the page is inert while it is open", async ({
  page,
}, info) => {
  await openBuilder(page, info.project.name);
  const eventId = page.url().split("/").at(-2) ?? "";
  expect((await page.request.post(`${CONTROL}/make-admin`, { data: { eventId } })).status()).toBe(
    204,
  );
  await page.goto("/en/console/questify");
  await page.getByRole("button", { name: "New campaign" }).click();
  await page.getByLabel("Campaign name in Arabic", { exact: true }).fill("موسم الصيف");
  await page
    .getByLabel("Campaign name in English", { exact: true })
    .fill(`Summer ${info.project.name}`);
  await page.getByLabel("Starts (Saudi time)", { exact: true }).fill(inDays(1));
  await page.getByLabel("Ends (Saudi time)", { exact: true }).fill(inDays(30));
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const campaign = page
    .getByTestId("questify-campaign")
    .filter({ hasText: `Summer ${info.project.name}` });
  const publishCalls: string[] = [];
  page.on("request", (sent) => {
    if (sent.method() === "POST" && sent.url().endsWith("/publish")) {
      publishCalls.push(sent.url());
    }
  });
  const publish = campaign.getByRole("button", { name: "Publish campaign" });
  await publish.click();
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await expect(campaign.locator("xpath=ancestor::ul")).toHaveJSProperty("inert", true);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(publish).toBeFocused();
  await expect(campaign.locator("xpath=ancestor::ul")).toHaveJSProperty("inert", false);
  expect(publishCalls).toHaveLength(0);
});

test("an organizer who is not a Questify admin does not find the page", async ({ page }, info) => {
  await openBuilder(page, info.project.name);
  const response = await page.goto("/ar/console/questify");
  expect(response?.status()).toBe(404);
});
