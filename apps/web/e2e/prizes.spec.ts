import { expect, test } from "@playwright/test";
import { openBuilder } from "#e2e/builder.ts";
import { CONTROL_PORT } from "#e2e/paths.ts";

/**
 * Rank prizes and final results (T-214), in Arabic: the owner adds a prize and the rules text, the public rules page
 * shows the fixed block, then after the end the owner confirms the places (a flagged player named in the sheet) and
 * reveals the winners; the page's heading in English.
 */
test("the owner sets a rank prize, confirms the results and reveals the winners", async ({
  page,
  request,
}, info) => {
  test.setTimeout(90_000);
  await openBuilder(page, info.project.name);
  const eventId = /\/events\/([0-9a-f-]{36})\/quests/.exec(page.url())?.[1];
  const tag = `${info.project.name.slice(0, 2)}${Date.now() % 1_000_000}`;
  const control = `http://127.0.0.1:${CONTROL_PORT}`;

  await page.goto(page.url().replace(/\/quests$/, "/prizes"));
  await expect(page.getByRole("heading", { name: "جوائز الترتيب", level: 2 })).toBeVisible();
  await expect(page.getByText("لا توجد جوائز ترتيب بعد.")).toBeVisible();
  await page.getByRole("button", { name: "إضافة جائزة" }).click();
  await page.getByLabel("النوع").selectOption("experience");
  await page.getByLabel("الاسم بالعربية", { exact: true }).fill("جولة خلف الكواليس");
  await page.getByLabel("الاسم بالإنجليزية", { exact: true }).fill("Backstage tour");
  await page.getByRole("button", { name: "حفظ الجائزة" }).click();
  await expect(page.getByRole("status")).toHaveText("حُفظت الجائزة.");
  await expect(page.getByRole("listitem").filter({ hasText: "جولة خلف الكواليس" })).toContainText(
    "المركز 1",
  );
  await page.getByLabel("القواعد بالعربية").fill("أحضر هويتك عند الاستلام.");
  await page.getByRole("button", { name: "حفظ القواعد" }).click();
  await expect(page.getByRole("status")).toHaveText("حُفظت القواعد.");
  const rulesPage = await page
    .getByRole("link", { name: "صفحة القواعد العامة" })
    .getAttribute("href");

  const live = await request.post(`${control}/event-status`, { data: { eventId, status: "live" } });
  expect(live.status()).toBe(204);
  const prizesPage = page.url();
  await page.goto(rulesPage ?? "");
  await expect(page.getByRole("heading", { name: "القواعد الرسمية", level: 1 })).toBeVisible();
  await expect(
    page.getByText("Apple وGoogle ليستا راعيتين لهذه المسابقة ولا علاقة لهما بها بأي شكل."),
  ).toBeVisible();
  await expect(page.getByText("المركز 1: جولة خلف الكواليس")).toBeVisible();
  await expect(page.getByText("أحضر هويتك عند الاستلام.")).toBeVisible();

  const seeded = await request.post(`${control}/scored`, {
    data: {
      eventId,
      usernames: [`hawk_${tag}`, `owl_${tag}`],
      points: [300, 100],
      flagged: [`owl_${tag}`],
    },
  });
  expect(seeded.status()).toBe(204);
  const ended = await request.post(`${control}/event-status`, {
    data: { eventId, status: "ended" },
  });
  expect(ended.status()).toBe(204);

  await page.goto(prizesPage);
  await expect(
    page.getByText("انتهت الفعالية. راجع المراكز والبلاغات المفتوحة ثم أكّد النتائج."),
  ).toBeVisible();
  const owl = page.getByRole("listitem").filter({ hasText: `@owl_${tag}` });
  await expect(owl).toContainText("بلاغات مفتوحة: 1");
  await page.getByRole("button", { name: "تأكيد النتائج" }).click();
  const confirm = page.getByRole("alertdialog");
  await expect(confirm).toContainText(`بلاغات مفتوحة على: @owl_${tag}`);
  await confirm.getByRole("button", { name: "تأكيد النتائج" }).click();
  await expect(page.getByRole("status")).toHaveText("أُكّدت النتائج.");

  await page.getByRole("button", { name: "إعلان الفائزين" }).click();
  const reveal = page.getByRole("alertdialog");
  await expect(reveal).toContainText("سيرى الفائزون جوائزهم في التطبيق");
  await reveal.getByRole("button", { name: "إعلان الفائزين" }).click();
  await expect(page.getByRole("status")).toHaveText("أُعلن الفائزون.");
  await expect(page.getByRole("listitem").filter({ hasText: `@hawk_${tag}` })).toContainText(
    "بانتظار الاستلام",
  );

  await page.goto(page.url().replace("/ar/", "/en/"));
  await expect(page.getByRole("heading", { name: "Final results", level: 2 })).toBeVisible();
});
