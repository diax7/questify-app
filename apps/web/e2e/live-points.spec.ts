import { expect, test, type Page } from "@playwright/test";
import { openBuilder } from "#e2e/builder.ts";
import { CONTROL_PORT } from "#e2e/paths.ts";

const CONTROL = `http://127.0.0.1:${CONTROL_PORT}`;
const STAGE = "ابحث عن المسرح";
const SPONSORS = "زر جناح الرعاة";

type Impact = {
  eligible: boolean;
  completions: number;
  players: number;
  raise: number;
  lower: number;
};

/** The builder page of a live event with two quests that real players completed (3 players on one, 2 on the other). */
async function playedEvent(
  page: Page,
  project: string,
): Promise<{ base: string; stage: string; questsPath: string }> {
  await openBuilder(page, project);
  for (const title of [STAGE, SPONSORS]) {
    await page
      .getByRole("region", { name: "عام" })
      .getByRole("button", { name: "إضافة مهمة" })
      .click();
    await page.getByLabel("العنوان بالعربية", { exact: true }).fill(title);
    await page.getByRole("button", { name: "إنشاء مهمة" }).click();
    await expect(page.getByText(title, { exact: true })).toBeVisible();
  }
  const [, organizerId, eventId] = /\/organizers\/([0-9a-f-]{36})\/events\/([0-9a-f-]{36})\//.exec(
    page.url(),
  ) ?? ["", "", ""];
  const moved = await page.request.post(`${CONTROL}/event-status`, {
    data: { eventId, status: "live" },
  });
  expect(moved.status()).toBe(204);
  const tag = `${project.slice(0, 2)}${Date.now() % 1_000_000}`;
  for (const [title, count] of [
    [STAGE, 3],
    [SPONSORS, 2],
  ] as const) {
    const seeded = await page.request.post(`${CONTROL}/played`, {
      data: {
        eventId,
        ar: title,
        usernames: Array.from({ length: count }, (_, n) => `pl${count}_${tag}_${n}`),
      },
    });
    expect(seeded.status(), await seeded.text()).toBe(204);
  }
  await page.reload();
  await expect(page.getByText("الفعالية جارية: يظهر كل تغيير في التطبيق فورًا.")).toBeVisible();
  const questsPath = `/v1/organizers/${organizerId}/events/${eventId}/quests`;
  const listed = await page.request.get(questsPath);
  const { categories } = (await listed.json()) as {
    categories: { quests: { id: string; title: { ar: string } }[] }[];
  };
  const stage = categories.flatMap((c) => c.quests).find((q) => q.title.ar === STAGE)?.id ?? "";
  return { base: page.url(), stage, questsPath };
}

const rowOf = (page: Page, title: string) =>
  page.getByRole("region", { name: "عام" }).getByRole("listitem").filter({ hasText: title });

async function impactAt(
  page: Page,
  played: Readonly<{ stage: string; questsPath: string }>,
  points: number,
): Promise<Impact> {
  const answer = await page.request.get(
    `${played.questsPath}/${played.stage}/impact?points=${points}`,
  );
  expect(answer.status()).toBe(200);
  return (await answer.json()) as Impact;
}

/**
 * Changing the points of a quest that real players completed, and deleting one, in a live event (T-604, FR-411 to
 * FR-413), in Arabic: the dialogs show the real counts, choose nothing for the person, change nothing when cancelled, and
 * send the chosen answer.
 */
test("new points on a played quest ask future or past first, and Cancel changes nothing", async ({
  page,
}, info) => {
  test.setTimeout(150_000);
  const played = await playedEvent(page, info.project.name);
  const edit = rowOf(page, STAGE).getByRole("button", { name: "تعديل", exact: true });
  const points = page.getByRole("spinbutton").first();

  await edit.click();
  const before = Number(await points.inputValue());
  await points.fill(String(before + 15));
  await page.getByRole("button", { name: "حفظ مهمة" }).click();

  const dialog = page.getByRole("alertdialog");
  await expect(dialog.getByRole("heading", { name: `تغيير نقاط «${STAGE}»؟` })).toBeFocused();
  await expect(dialog).toContainText("أُنجزت 3 مرة حتى الآن من 3 لاعبًا.");
  // Nothing is chosen for the person: the button waits for a choice.
  const save = dialog.getByRole("button", { name: "حفظ النقاط" });
  await expect(save).toBeDisabled();
  await expect(dialog.getByLabel(/^الإنجازات القادمة فقط/)).not.toBeChecked();
  const past = dialog.getByLabel(/^الإنجازات السابقة أيضًا/);
  await expect(past).not.toBeChecked();
  await past.check();
  await expect(past).toHaveAccessibleName(/\(3 بالزيادة، 0 بالنقص\)/);
  await expect(save).toBeEnabled();

  // Cancel sends nothing: the real completions still stand at the old points.
  await dialog.getByRole("button", { name: "إلغاء" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(edit).toBeFocused();
  expect(await impactAt(page, played, before)).toMatchObject({ raise: 0, lower: 0 });

  // "Future only" saves the new points and leaves the three past completions where they were.
  await edit.click();
  await points.fill(String(before + 15));
  await page.getByRole("button", { name: "حفظ مهمة" }).click();
  await dialog.getByLabel(/^الإنجازات القادمة فقط/).check();
  await dialog.getByRole("button", { name: "حفظ النقاط" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(rowOf(page, STAGE)).toContainText(String(before + 15));
  expect(await impactAt(page, played, before)).toMatchObject({ raise: 0, lower: 0 });
  expect(await impactAt(page, played, before + 15)).toMatchObject({ raise: 3, lower: 0 });

  // "Past too" writes the new points for the three of them.
  await edit.click();
  await points.fill(String(before + 30));
  await page.getByRole("button", { name: "حفظ مهمة" }).click();
  await dialog.getByLabel(/^الإنجازات السابقة أيضًا/).check();
  await dialog.getByRole("button", { name: "حفظ النقاط" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(rowOf(page, STAGE)).toContainText(String(before + 30));
  expect(await impactAt(page, played, before + 30)).toMatchObject({ raise: 0, lower: 0 });
  expect(await impactAt(page, played, before)).toMatchObject({ raise: 0, lower: 3 });
});

test("deleting a played quest asks keep or remove first, and Cancel keeps the quest", async ({
  page,
}, info) => {
  test.setTimeout(150_000);
  await playedEvent(page, info.project.name);
  const row = rowOf(page, SPONSORS);
  const remove = row.getByRole("button", { name: "حذف مهمة" });

  await remove.click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog.getByRole("heading", { name: "حذف مهمة؟" })).toBeFocused();
  await expect(dialog).toContainText(`أُنجزت «${SPONSORS}» 2 مرة من 2 لاعبًا. ماذا يحدث لنقاطهم؟`);
  const confirm = dialog.getByRole("button", { name: "حذف مهمة" });
  // Nothing is chosen for the person: the button waits for a choice.
  await expect(confirm).toBeDisabled();
  await expect(dialog.getByLabel(/^تبقى نقاطهم/)).not.toBeChecked();
  await expect(dialog.getByLabel(/^تُسحب نقاطها/)).not.toBeChecked();
  await dialog.getByLabel(/^تُسحب نقاطها/).check();
  await expect(confirm).toBeEnabled();

  await dialog.getByRole("button", { name: "إلغاء" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(remove).toBeFocused();
  await expect(row).toHaveCount(1);

  await remove.click();
  await dialog.getByLabel(/^تبقى نقاطهم/).check();
  await dialog.getByRole("button", { name: "حذف مهمة" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(row).toHaveCount(0);
  await expect(rowOf(page, STAGE)).toHaveCount(1);
});
