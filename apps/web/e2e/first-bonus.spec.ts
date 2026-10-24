import { expect, test, type Page } from "@playwright/test";
import { openBuilder } from "#e2e/builder.ts";
import { CONTROL_PORT } from "#e2e/paths.ts";

/**
 * The first-N bonus (T-313), in Arabic: a quest saved with a bonus for its first 2 players shows "First 2: 2 left";
 * two players complete it through the API and each gets the bonus, the third finds it all taken; the list then says
 * none is left and the form keeps the bonus's points read-only. Desktop and phone.
 */

const API = "http://127.0.0.1:4100";
const CONTROL = `http://127.0.0.1:${CONTROL_PORT}`;

async function expectNoSidewaysScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

test("pays the bonus to the first two players, and the third finds it all taken", async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  await openBuilder(page, info.project.name);
  await page.getByRole("button", { name: "إضافة مهمة" }).click();
  await page.getByRole("combobox", { name: /^نوع مهمة/ }).selectOption("enter_code");
  await page.getByLabel("العنوان بالعربية", { exact: true }).fill("بوابة الدخول");
  await page.getByLabel("الرمز", { exact: true }).fill("NAJD2030");
  await page.getByLabel("مكافأة الأوائل").check();
  await page.getByLabel(/^المكافأة \(/).fill("25");
  await page.getByLabel(/^لأول كم/).fill("2");
  await expect(page.getByText(/^أول 2 يُنهون هذه/)).toBeVisible();
  await expectNoSidewaysScroll(page);
  await page.getByRole("button", { name: "إنشاء مهمة" }).click();
  const quest = page.getByRole("listitem").filter({ hasText: "بوابة الدخول" });
  await expect(quest.getByText("أول 2: بقي 2")).toBeVisible();

  const eventId =
    page
      .url()
      .replace(/\/quests$/, "")
      .split("/")
      .at(-1) ?? "";
  await page.request.post(`${CONTROL}/event-status`, { data: { eventId, status: "live" } });
  const tokenOf = async (n: number) =>
    (
      (await (
        await page.request.post(`${CONTROL}/player-token`, {
          data: { eventId, usernames: [`bonus_${info.project.name}_${n}_${Date.now() % 1e6}`] },
        })
      ).json()) as { token: string }
    ).token;
  const players = [await tokenOf(1), await tokenOf(2), await tokenOf(3)];
  const questsOf = async (token: string) =>
    (await (
      await page.request.get(`${API}/v1/events/${eventId}/quests`, {
        headers: { authorization: `Bearer ${token}` },
      })
    ).json()) as {
      categories: { quests: { id: string; firstBonus: { left: number; mine: unknown } }[] }[];
    };
  const questId = (await questsOf(players[0] ?? "")).categories[0]?.quests[0]?.id ?? "";
  const answers: { firstBonus: { place: number | null } }[] = [];
  for (const token of players) {
    const paid = await page.request.post(`${API}/v1/quests/${questId}/complete`, {
      headers: { authorization: `Bearer ${token}`, "idempotency-key": crypto.randomUUID() },
      data: { proof: { type: "code", code: "NAJD2030" } },
    });
    expect(paid.status(), await paid.text()).toBe(200);
    answers.push(await paid.json());
  }
  expect(answers.map((answer) => answer.firstBonus.place)).toEqual([1, 2, null]);
  // The counts are kept per event for 2 seconds (ADR-263): read again once the first read's copy is stale.
  await page.waitForTimeout(2100);
  const third = (await questsOf(players[2] ?? "")).categories[0]?.quests[0]?.firstBonus;
  expect(third).toMatchObject({ left: 0, mine: null });

  await page.reload();
  await expect(quest.getByText("أول 2: بقي 0")).toBeVisible();
  await quest.getByRole("button", { name: "تعديل" }).click();
  await expect(page.getByLabel(/^المكافأة \(/)).toHaveAttribute("readonly", "");
  await expect(page.getByText("حصل عليها 2 حتى الآن، فلا تتغيّر قيمتها")).toBeVisible();
  await expect(page.getByRole("button", { name: "أوقف المكافأة" })).toHaveCount(0);
  await expectNoSidewaysScroll(page);
});
