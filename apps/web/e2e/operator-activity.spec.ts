import { expect, test, type Page } from "@playwright/test";
import { openBuilder } from "#e2e/builder.ts";
import { expectCleanLayout, waitUntilSettled, watchRequests } from "#e2e/layout.ts";
import { openMenu } from "#e2e/nav.ts";
import { CONTROL_PORT } from "#e2e/paths.ts";

const CONTROL = `http://127.0.0.1:${CONTROL_PORT}`;

/** The filled page read as the layout check reads every page: no overflow, overlap, small text or nested box. */
async function checkLayout(page: Page, where: string): Promise<void> {
  await page.evaluate(() => window.scrollTo(0, 0));
  await waitUntilSettled(page, where);
  await expectCleanLayout(page, where);
}

/**
 * The Operators page's activity and staff briefing (T-617, FR-1844), in Arabic: three operators (one active a minute or
 * two ago, one quiet for 45 minutes, one who never scanned) with the event's tiles, a card per operator, the latest
 * actions with "View more", and a briefing that is checked, confirmed with the number of operators it reaches, sent and
 * listed; then the English headings.
 */
test("the owner sees what each operator did and sends the operators a briefing", async ({
  page,
  request,
}, info) => {
  test.setTimeout(150_000);
  watchRequests(page);
  await openBuilder(page, info.project.name);
  const eventUrl = page.url().replace(/\/quests$/, "");
  const eventId = /\/events\/([0-9a-f-]{36})$/.exec(eventUrl)?.[1] ?? "";
  const tag = `${info.project.name.slice(0, 2)}${Date.now() % 1_000_000}`;
  const live = await request.post(`${CONTROL}/event-status`, { data: { eventId, status: "live" } });
  expect(live.status()).toBe(204);
  const seeded = await request.post(`${CONTROL}/operator-seed`, {
    data: {
      eventId,
      operators: [
        { username: `nora_${tag}`, scans: [2, 3, 4, 6, 8, 10] },
        { username: `omar_${tag}`, scans: [45, 50] },
        { username: `sami_${tag}`, scans: [], banned: true },
      ],
    },
  });
  expect(seeded.status(), await seeded.text()).toBe(204);

  await page.goto(eventUrl);
  await openMenu(page);
  await page.getByRole("link", { name: "المشغّلون", exact: true }).click();
  await expect(page.getByRole("heading", { name: "نشاط المشغّلين", level: 2 })).toBeVisible();

  // The tiles: one operator active in the last 30 minutes, eight scans in the last hour.
  const tile = (name: string) => page.getByRole("region", { name, exact: true });
  await expect(tile("نشطون خلال 30 دقيقة")).toContainText("1");
  await expect(tile("مسحات آخر ساعة")).toContainText("8");

  // A card per operator, the most recently active first; the quiet ones are marked, and the one who never acted says so.
  const operators = page.getByRole("region", { name: "حسب المشغّل" });
  const rows = operators.getByRole("listitem");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText(`@nora_${tag}`);
  await expect(rows.nth(0)).toContainText(/آخر نشاط: مسح · قبل (دقيقتين|\d+ دقائق)/);
  await expect(rows.nth(0)).toContainText("المسحات: 6 آخر ساعة");
  await expect(rows.nth(0)).not.toContainText("هادئ");
  await expect(rows.nth(1)).toContainText(`@omar_${tag}`);
  await expect(rows.nth(1)).toContainText(/قبل 4[5-9] دقيقة/);
  await expect(rows.nth(1)).toContainText("هادئ");
  await expect(rows.nth(2)).toContainText(`@sami_${tag}`);
  await expect(rows.nth(2)).toContainText("لا نشاط بعد");
  await expect(rows.nth(2)).toContainText("هادئ");

  // The latest actions: five, then all eight with "View more"; the button goes when there is no more.
  const recent = page.getByRole("region", { name: "آخر الإجراءات" });
  await expect(recent.getByRole("listitem")).toHaveCount(5);
  await expect(recent.getByRole("listitem").first()).toContainText("مسح · البوابة الرئيسية");
  await recent.getByRole("button", { name: /^عرض المزيد/ }).click();
  await expect(recent.getByRole("listitem")).toHaveCount(8);
  await expect(recent.getByRole("button", { name: /^عرض المزيد/ })).toHaveCount(0);

  // The briefing: a refusal names the field, a good one asks first and says how many operators it reaches.
  const briefing = page.getByRole("region", { name: "رسالة إلى المشغّلين" });
  await expect(briefing.getByText("لم تُرسل رسائل بعد.")).toBeVisible();
  await briefing.getByRole("button", { name: "إرسال" }).click();
  await expect(briefing.getByRole("alert")).toContainText(
    "راجع «العنوان بالعربية»: هذا الحقل مطلوب.",
  );
  await briefing.getByLabel("العنوان بالعربية").fill("تغيير البوابة");
  await briefing.getByLabel("العنوان بالإنجليزية").fill("Gate change");
  await briefing.getByLabel("النص بالعربية").fill("البوابة 3 مغلقة. استخدموا البوابة 1.");
  await briefing.getByLabel("النص بالإنجليزية").fill("Call 0551234567");
  await briefing.getByRole("button", { name: "إرسال" }).click();
  await expect(briefing.getByRole("alert")).toContainText("لا يُسمح بأرقام الهاتف في الرسالة.");
  await briefing.getByLabel("النص بالإنجليزية").fill("Gate 3 is closed. Use gate 1.");
  await expect(briefing.getByText("29 من 140")).toBeVisible();

  await checkLayout(page, `${info.project.name} operators activity`);

  await briefing.getByRole("button", { name: "إرسال" }).click();
  const confirm = page.getByRole("alertdialog");
  // Three operators are listed, but the banned one is not told, so the confirmation says two.
  await expect(confirm).toContainText("المشغّلون الذين سيصلهم الإشعار: 2. لن يصل إلى اللاعبين.");
  await confirm.getByRole("button", { name: "إرسال" }).click();
  await expect(briefing.getByRole("status")).toContainText("عدد المشغّلين الذين وصلهم الإشعار: 2");
  await expect(briefing.getByText("تغيير البوابة")).toBeVisible();
  await expect(briefing.getByText("وصلت إلى: 2")).toBeVisible();
  await expect(briefing.getByLabel("العنوان بالعربية")).toHaveValue("");

  await page.goto(`${eventUrl.replace("/ar/", "/en/")}/operators`);
  await expect(page.getByRole("heading", { name: "Operator activity", level: 2 })).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Scans in the last hour", exact: true }),
  ).toContainText("8");
  const english = page.getByRole("region", { name: "By operator" });
  await expect(english.getByRole("listitem").first()).toContainText(
    "Last activity: Scan · 2 minutes ago",
  );
  await expect(english.getByRole("listitem").nth(1)).toContainText("Quiet");
  await expect(page.getByRole("region", { name: "Message the operators" })).toContainText(
    "Notified: 2",
  );
  await checkLayout(page, `${info.project.name} operators activity en`);
});

test("the Operators page shows no activity for an event with no operators", async ({
  page,
}, info) => {
  test.setTimeout(60_000);
  await openBuilder(page, info.project.name);
  const eventUrl = page.url().replace(/\/quests$/, "");
  await page.goto(`${eventUrl}/operators`);
  await expect(page.getByText("لا مشغّلين بعد.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "نشاط المشغّلين" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "رسالة إلى المشغّلين" })).toHaveCount(0);
});
