import { expect, test, type Page } from "@playwright/test";
import { openBuilder } from "#e2e/builder.ts";
import { CONTROL_PORT } from "#e2e/paths.ts";

async function addQuest(page: Page, category: string, title: string): Promise<void> {
  await page
    .getByRole("region", { name: category })
    .getByRole("button", { name: "إضافة مهمة" })
    .click();
  await page.getByLabel("العنوان بالعربية", { exact: true }).fill(title);
  await page.getByRole("button", { name: "إضافة المهمة" }).click();
  await expect(page.getByText(title, { exact: true })).toBeVisible();
}

test("builds categories and quests in Arabic, reorders, hides, and deletes a category by moving its quests", async ({
  page,
}, info) => {
  test.setTimeout(90_000);
  await openBuilder(page, info.project.name);
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByRole("region", { name: "عام" })).toBeVisible();

  await page.getByLabel("اسم الفئة بالعربية", { exact: true }).fill("المسرح");
  await page.getByRole("button", { name: "إضافة فئة" }).click();
  await expect(page.getByRole("region", { name: "المسرح" })).toBeVisible();

  await addQuest(page, "عام", "ابحث عن المسرح");
  await addQuest(page, "عام", "التقِ بالمتحدث");
  const general = page.getByRole("region", { name: "عام" });
  await general.getByRole("button", { name: "نقل «التقِ بالمتحدث» لأعلى" }).click();
  await expect(general.getByRole("listitem").first()).toContainText("التقِ بالمتحدث");

  await general.getByRole("listitem").first().getByRole("button", { name: "إخفاء" }).click();
  await expect(general.getByRole("listitem").first()).toContainText("مخفية");

  await general.getByRole("button", { name: "حذف الفئة" }).click();
  await expect(page.getByText("عدد المهام في «عام»: 2. ماذا تريد أن تفعل بها؟")).toBeVisible();
  const dialog = page.getByRole("alertdialog");
  // Nothing is chosen for the person: the button waits for a choice.
  await expect(dialog.getByRole("button", { name: "حذف الفئة" })).toBeDisabled();
  await dialog.getByLabel("نقلها إلى المسرح").check();
  await dialog.getByRole("button", { name: "حذف الفئة" }).click();
  await expect(page.getByRole("heading", { name: "المهام", level: 1 })).toBeFocused();
  await expect(page.getByRole("region", { name: "عام" })).toHaveCount(0);
  const stage = page.getByRole("region", { name: "المسرح" });
  await expect(stage.getByRole("listitem")).toHaveCount(2);
});

test("an entry-code quest refuses a short code before sending anything", async ({ page }, info) => {
  test.setTimeout(90_000);
  await openBuilder(page, info.project.name);
  await page.getByRole("button", { name: "إضافة مهمة" }).click();
  await page.getByRole("combobox", { name: /^نوع المهمة/ }).selectOption("enter_code");
  await page.getByLabel("العنوان بالعربية", { exact: true }).fill("الرمز السري");
  await page.getByLabel("الرمز", { exact: true }).fill("ab");
  // The browser's own check refuses first; the shared rules catch what it misses.
  await page
    .getByLabel("الرمز", { exact: true })
    .evaluate((input) => input.removeAttribute("pattern"));
  await page.getByRole("button", { name: "إضافة المهمة" }).click();
  await expect(page.getByText("راجع حقول نوع المهمة، مثل الرمز.")).toBeVisible();
  await page.getByLabel("الرمز", { exact: true }).fill("najd2030");
  await page.getByRole("button", { name: "إضافة المهمة" }).click();
  await expect(page.getByText("الرمز السري", { exact: true })).toBeVisible();
});

test("a dialog opened far down the page comes into view and takes the focus", async ({
  page,
}, info) => {
  test.setTimeout(90_000);
  await openBuilder(page, info.project.name);
  for (const name of ["الأولى", "الثانية", "الثالثة", "الرابعة"]) {
    await page.getByLabel("اسم الفئة بالعربية", { exact: true }).fill(name);
    await page.getByRole("button", { name: "إضافة فئة" }).click();
    await expect(page.getByRole("region", { name })).toBeVisible();
  }
  const last = page.getByRole("region", { name: "الرابعة" });
  await last.getByRole("button", { name: "حذف الفئة" }).click();
  const heading = page.getByRole("heading", { name: "حذف الفئة؟" });
  await expect(heading).toBeFocused();
  await expect(heading).toBeInViewport();
  await page.getByRole("alertdialog").getByRole("button", { name: "إلغاء" }).click();
  await expect(last.getByRole("button", { name: "حذف الفئة" })).toBeFocused();
});

test("in a live event, a change waits for the confirmation and then goes through", async ({
  page,
  request,
}, info) => {
  test.setTimeout(90_000);
  await openBuilder(page, info.project.name);
  await addQuest(page, "عام", "ابحث عن المسرح");
  const eventId = /\/events\/([0-9a-f-]{36})\/quests/.exec(page.url())?.[1];
  const moved = await request.post(`http://127.0.0.1:${CONTROL_PORT}/event-status`, {
    data: { eventId, status: "live" },
  });
  expect(moved.status()).toBe(204);
  await page.reload();
  await expect(page.getByText("الفعالية جارية: يظهر كل تغيير في التطبيق فورًا.")).toBeVisible();
  await page.getByRole("button", { name: "إخفاء" }).click();
  await expect(page.getByRole("heading", { name: "الفعالية جارية" })).toBeFocused();
  await page.getByRole("alertdialog").getByRole("button", { name: "متابعة" }).click();
  await expect(page.getByRole("region", { name: "عام" }).getByRole("listitem")).toContainText(
    "مخفية",
  );
});

test("pins one quest as Up next, moves the pin, warns while it is hidden, and clears it", async ({
  page,
}, info) => {
  test.setTimeout(90_000);
  await openBuilder(page, info.project.name);
  await addQuest(page, "عام", "زر جناح الرعاة");
  await addQuest(page, "عام", "التقط صورة");
  const general = page.getByRole("region", { name: "عام" });
  const first = general.getByRole("listitem").filter({ hasText: "زر جناح الرعاة" });
  const second = general.getByRole("listitem").filter({ hasText: "التقط صورة" });
  const pinOf = (row: typeof first) => row.getByRole("button", { name: "تثبيت كمهمة تالية" });

  await pinOf(first).click();
  await expect(pinOf(first)).toHaveAttribute("aria-pressed", "true");
  await expect(first).toContainText("مثبّتة كمهمة تالية");
  await expect(pinOf(second)).toHaveAttribute("aria-pressed", "false");

  // One pin per event: pinning another moves it.
  await pinOf(second).click();
  await expect(pinOf(second)).toHaveAttribute("aria-pressed", "true");
  await expect(pinOf(first)).toHaveAttribute("aria-pressed", "false");
  await expect(first).not.toContainText("مثبّتة كمهمة تالية");

  await second.getByRole("button", { name: "إخفاء" }).click();
  await expect(second).toContainText("مخفية، فلن تظهر مهمةً تالية حتى تُظهرها.");

  await pinOf(second).click();
  await expect(pinOf(second)).toHaveAttribute("aria-pressed", "false");
  await expect(general).not.toContainText("مثبّتة كمهمة تالية");
});

test("sets a category's order, opening time, unlock and bonus, and shows them on its card (T-304)", async ({
  page,
}, info) => {
  test.setTimeout(90_000);
  await openBuilder(page, info.project.name);
  await page.getByLabel("اسم الفئة بالعربية", { exact: true }).fill("الفصل الثاني");
  await page.getByRole("button", { name: "إضافة فئة" }).click();
  const second = page.getByRole("region", { name: "الفصل الثاني" });
  await second.getByRole("button", { name: "تعديل الفئة" }).click();
  await second.getByLabel("ترتيب المهام").selectOption("in_order");
  await second.getByLabel("تُفتح الفئة").fill("2030-11-01T16:00");
  await second.getByLabel("تُفتح بعد إكمال").selectOption({ label: "عام" });
  await second.getByLabel("مكافأة إكمال كل مهام الفئة").fill("250");
  await second.getByRole("button", { name: "حفظ الفئة" }).click();
  await expect(second.getByText(/بالترتيب · تُفتح .* · بعد «عام» · مكافأة/)).toBeVisible();
  await expect(second.getByText(/250/)).toBeVisible();
  await page
    .getByRole("region", { name: "عام" })
    .getByRole("button", { name: "حذف الفئة" })
    .click();
  await page.getByRole("alertdialog").getByRole("button", { name: "حذف الفئة" }).click();
  await expect(
    page.getByText("تُفتح فئات أخرى بعد إكمال هذه الفئة", { exact: false }),
  ).toBeVisible();
});
