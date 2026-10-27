import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { openBuilder } from "#e2e/builder.ts";
import { CONTROL_PORT } from "#e2e/paths.ts";

/**
 * The shop window on the dashboard (T-410b, ADR-336, ADR-338), in both languages: the closing line, the days field's
 * rules after the end and once closed, `daysAfter` sent only when it changed, and the words of each refusal when the
 * page was stale. The event is a draft that ends on 2030-11-01 17:00 with the default 3 days after, so it closes on
 * 2030-11-04 17:00 until the days change.
 */
const TEXT = {
  ar: {
    region: "الجوائز",
    days: "أيام بقاء المتجر بعد نهاية الفعالية",
    pickup: "مهلة الاستلام بالدقائق",
    save: "حفظ الإعدادات",
    saved: "حُفظت إعدادات المتجر.",
    closes: (day: number) => new RegExp(`يُغلق المتجر في .*${day} نوفمبر 2030`),
    closesAny: /يُغلق المتجر في .*\d{4}/,
    closedAny: /أُغلق المتجر في .*\d{4}/,
    onlyLonger: "بعد نهاية الفعالية يمكنك زيادة الأيام فقط.",
    frozen: "أُغلق المتجر، فلا يمكن تغيير أيامه.",
    shorterInvalid: "بعد نهاية الفعالية لا يمكن تقصير مدة بقاء المتجر.",
    lockedShorter:
      "لا يمكن تقصير مدة بقاء المتجر بعد نهاية الفعالية، فقد رأى اللاعبون موعد الإغلاق. يمكنك زيادتها فقط.",
    lockedClosed: "أُغلق المتجر ولا يمكن تغيير أيامه، حتى بالزيادة.",
    deskEndsEarly:
      "تنتهي ساعات المكتب قبل إغلاق المتجر، فيتوقف حجز القطع والتجارب عندها، وتبقى الجوائز الرقمية حتى الإغلاق.",
  },
  en: {
    region: "Rewards",
    days: "Days the shop stays open after the event",
    pickup: "Pickup time in minutes",
    save: "Save the settings",
    saved: "The shop settings are saved.",
    closes: (day: number) => new RegExp(`The shop closes on .*${day} Nov 2030`),
    closesAny: /The shop closes on .*\d{4}/,
    closedAny: /The shop closed on .*\d{4}/,
    onlyLonger: "After the event ends, you can only add days.",
    frozen: "The shop has closed, so its days can't change.",
    shorterInvalid: "After the event ends, the shop's days can't be shortened.",
    lockedShorter:
      "After the event ends, the shop's days can't be shortened, because players have seen the closing date. You can only add days.",
    lockedClosed: "The shop has closed, so its days can't change, not even to add more.",
    deskEndsEarly:
      "The prize desk's hours end before the shop closes: items and experiences stop then; digital rewards stay until the close.",
  },
} as const;

type Language = keyof typeof TEXT;

const control = `http://127.0.0.1:${CONTROL_PORT}`;

/** Signs up, creates the draft event and opens its Rewards page in the language. */
async function openRewards(page: Page, project: string, language: Language) {
  await openBuilder(page, project);
  const ids = /\/organizers\/([0-9a-f-]{36})\/events\/([0-9a-f-]{36})\/quests/.exec(page.url());
  const [, organizerId, eventId] = ids ?? [];
  const url = page
    .url()
    .replace(/\/quests$/, "/rewards")
    .replace("/ar/", `/${language}/`);
  await page.goto(url);
  return {
    url,
    eventId: eventId ?? "",
    shop: `/v1/organizers/${organizerId}/events/${eventId}/shop`,
    panel: page.getByRole("region", { name: TEXT[language].region }),
  };
}

/** Saves shop settings from outside the form with the page's own session, as another editor would. */
async function putShop(page: Page, shop: string, body: Record<string, unknown>) {
  const status = await page.evaluate(
    async ([path, payload]) => {
      const response = await fetch(path as string, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      return response.status;
    },
    [shop, body] as const,
  );
  expect(status).toBe(200);
}

async function endEvent(request: APIRequestContext, eventId: string, endedDaysAgo: number) {
  const answer = await request.post(`${control}/event-status`, {
    data: { eventId, status: "ended", endedDaysAgo },
  });
  expect(answer.status()).toBe(204);
}

async function expectNoSideways(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
}

for (const language of ["ar", "en"] as const) {
  const t = TEXT[language];

  test(`the shop's days only grow after the event ends (${language})`, async ({
    page,
    request,
  }, info) => {
    test.setTimeout(120_000);
    const { url, eventId, shop, panel } = await openRewards(page, info.project.name, language);
    const days = panel.getByLabel(t.days);
    const save = panel.getByRole("button", { name: t.save });

    // Before the end: the closing line says when, and the days change freely.
    await expect(panel.getByText(t.closes(4))).toBeVisible();
    await expect(panel.getByText(t.onlyLonger)).toHaveCount(0);
    await days.fill("5");
    await save.click();
    await expect(panel.getByRole("status")).toHaveText(t.saved);
    await expect(panel.getByText(t.closes(6))).toBeVisible();

    // A desk whose last window ends before the shop closes is warned about.
    await expect(panel.getByText(t.deskEndsEarly)).toHaveCount(0);
    await putShop(page, shop, {
      desk: {
        location: { ar: "القاعة ب", en: "Hall B" },
        hours: [{ opensAt: "2030-11-01T09:00", closesAt: "2030-11-01T16:00" }],
      },
    });
    await page.reload();
    await expect(panel.getByText(t.deskEndsEarly)).toBeVisible();

    // After the end, while open: only longer.
    await endEvent(request, eventId, 1);
    await page.goto(url);
    await expect(panel.getByText(t.closesAny)).toBeVisible();
    await expect(panel.getByText(t.onlyLonger)).toBeVisible();
    await expect(days).toBeEnabled();
    await days.fill("2");
    await save.click();
    await expect(panel.getByRole("alert")).toHaveText(t.shorterInvalid);

    // Saving something else does not send the days (a stale page cannot trip over them).
    await days.fill("5");
    await panel.getByLabel(t.pickup).fill("60");
    const unrelated = page.waitForRequest((r) => r.method() === "PUT" && r.url().endsWith("/shop"));
    await save.click();
    expect((await unrelated).postDataJSON()).not.toHaveProperty("daysAfter");
    await expect(panel.getByRole("status")).toHaveText(t.saved);

    // Longer is saved.
    await days.fill("7");
    const longer = page.waitForRequest((r) => r.method() === "PUT" && r.url().endsWith("/shop"));
    await save.click();
    expect((await longer).postDataJSON()).toMatchObject({ daysAfter: 7 });
    await expect(panel.getByRole("status")).toHaveText(t.saved);
    await page.reload();
    await expect(days).toHaveValue("7");

    // A stale page: someone else lengthened it to 9; this page still holds 7 and asks for 8.
    await putShop(page, shop, { daysAfter: 9 });
    await days.fill("8");
    await save.click();
    await expect(panel.getByRole("alert")).toHaveText(t.lockedShorter);
    await expect(days).toHaveValue("9");
    await expectNoSideways(page);
  });

  test(`a closed shop's days are frozen (${language})`, async ({ page, request }, info) => {
    test.setTimeout(120_000);
    const { url, eventId, panel } = await openRewards(page, info.project.name, language);
    const days = panel.getByLabel(t.days);
    const save = panel.getByRole("button", { name: t.save });

    // Ended 2 days ago with 3 days after: still open, so the page loads with an editable field.
    await endEvent(request, eventId, 2);
    await page.goto(url);
    await expect(panel.getByText(t.closesAny)).toBeVisible();
    await expect(days).toBeEnabled();

    // The shop closes while the page is open; asking for more days is refused in words.
    await endEvent(request, eventId, 10);
    await days.fill("8");
    await save.click();
    await expect(panel.getByRole("alert")).toHaveText(t.lockedClosed);
    await expect(panel.getByText(t.closedAny)).toBeVisible();
    await expect(panel.getByText(t.frozen)).toBeVisible();
    await expect(days).toBeDisabled();
    await expect(days).toHaveValue("3");

    // The rest of the settings still save, without the days.
    await page.reload();
    await expect(days).toBeDisabled();
    await panel.getByLabel(t.pickup).fill("60");
    const unrelated = page.waitForRequest((r) => r.method() === "PUT" && r.url().endsWith("/shop"));
    await save.click();
    expect((await unrelated).postDataJSON()).not.toHaveProperty("daysAfter");
    await expect(panel.getByRole("status")).toHaveText(t.saved);
    await expectNoSideways(page);
  });
}
