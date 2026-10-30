import { expect, test } from "@playwright/test";
import { openBuilder } from "#e2e/builder.ts";
import { openMenu } from "#e2e/nav.ts";

/**
 * The event's words (T-117, T-311b): rename the currency, the player and the quest in Arabic and see them where the
 * dashboard uses them.
 */
test("the organizer renames the currency, the player and the quest", async ({ page }, info) => {
  test.setTimeout(90_000);
  await openBuilder(page, info.project.name);
  const eventPage = page.url().replace(/\/quests$/, "");
  await page.goto(eventPage);

  const words = page.getByRole("region", { name: "كلمات الفعالية" });
  const currency = words.getByRole("group", { name: "العملة", exact: true });
  const player = words.getByRole("group", { name: "اللاعب", exact: true });
  const quest = words.getByRole("group", { name: "المهمة", exact: true });
  const category = words.getByRole("group", { name: "الفئة", exact: true });
  await currency.getByRole("radio", { name: "جوهرة" }).check();
  await currency.getByLabel("بالعربية، مفرد").fill("جوهرة");
  await currency.getByLabel("بالعربية، جمع").fill("جواهر");
  await currency.getByLabel("بالإنجليزية، مفرد").fill("gem");
  await currency.getByLabel("بالإنجليزية، جمع").fill("gems");
  await player.getByLabel("بالعربية، مفرد").fill("طالب");
  await player.getByLabel("بالعربية، جمع").fill("طلاب");
  await player.getByLabel("بالإنجليزية، مفرد").fill("student");

  // A missing form is named, and its field takes the focus, before anything is sent.
  await player.getByLabel("بالإنجليزية، جمع").fill("");
  await words.getByRole("button", { name: "حفظ الكلمات" }).click();
  await expect(words.getByRole("alert")).toHaveText(
    "اللاعب، بالإنجليزية، جمع: اكتب من 1 إلى 30 حرفًا، دون أرقام أو أقواس معقوفة.",
  );
  await expect(player.getByLabel("بالإنجليزية، جمع")).toBeFocused();

  await player.getByLabel("بالإنجليزية، جمع").fill("students");
  await expect(words.getByText("جواهر: 120")).toBeVisible();
  await expect(words.getByText("عدد المرات لكل طالب: 3")).toBeVisible();
  await expect(words.getByText("Gems: 120")).toBeVisible();
  await quest.getByLabel("بالعربية، مفرد").fill("مغامرة");
  await quest.getByLabel("بالعربية، جمع").fill("مغامرات");
  await quest.getByLabel("بالإنجليزية، مفرد").fill("mission");
  await quest.getByLabel("بالإنجليزية، جمع").fill("missions");
  await expect(words.getByText("أنجز مغامرة لتدخل الترتيب.")).toBeVisible();
  await expect(words.getByText("Missions", { exact: true })).toBeVisible();
  await category.getByLabel("بالعربية، مفرد").fill("مرحلة");
  await category.getByLabel("بالعربية، جمع").fill("مراحل");
  await category.getByLabel("بالإنجليزية، مفرد").fill("stage");
  await category.getByLabel("بالإنجليزية، جمع").fill("stages");
  await words.getByRole("button", { name: "حفظ الكلمات" }).click();
  await expect(words.getByRole("status")).toHaveText("حُفظت الكلمات.");
  await openMenu(page);
  await expect(page.getByRole("link", { name: "طلاب" })).toBeVisible();

  await page.reload();
  await expect(currency.getByRole("radio", { name: "جوهرة" })).toBeChecked();
  await expect(quest.getByLabel("بالإنجليزية، جمع")).toHaveValue("missions");
  await openMenu(page);
  await page.getByRole("link", { name: "طلاب" }).click();
  await expect(page.getByRole("heading", { name: "طلاب", level: 1 })).toBeVisible();

  await page.goto(`${eventPage.replace("/ar/", "/en/")}/players`);
  await expect(page.getByRole("heading", { name: "Students", level: 1 })).toBeVisible();

  // The event's own page says them too, in the switch for community quests.
  await page.goto(eventPage);
  await expect(page.getByRole("heading", { name: "مغامرات للجميع" })).toBeVisible();

  // The builder and the other pages of the event say the event's words (T-311c, FR-942).
  const arabic = eventPage;
  const english = eventPage.replace("/ar/", "/en/");
  let listReads = 0;
  page.on("request", (request) => {
    if (request.method() === "GET" && /\/events\/[^/]+\/quests$/.test(request.url())) {
      listReads += 1;
    }
  });
  await page.goto(`${arabic}/quests`);
  await expect(page.getByRole("heading", { name: "مغامرات", level: 1 })).toBeVisible();
  await expect(page.getByRole("button", { name: "إضافة مغامرة" })).toBeVisible();
  await expect(page.getByRole("button", { name: "إضافة مرحلة" })).toBeVisible();
  // The words come with the page and are read once: the list is read on open and after changes, never in a loop.
  await page.waitForTimeout(3_000);
  expect(listReads).toBeLessThan(5);

  await page.goto(`${english}/quests`);
  await expect(page.getByRole("heading", { name: "Missions", level: 1 })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add mission" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add stage" })).toBeVisible();

  await page.goto(`${arabic}/codes`);
  await expect(
    page.getByText("لا مغامرات برموز QR بعد. أضف مغامرة من نوع مسح رمز QR."),
  ).toBeVisible();
  await page.goto(`${english}/codes`);
  await expect(page.getByText("No missions with codes yet. Add one that uses a QR.")).toBeVisible();
  await page.goto(`${arabic}/community`);
  await expect(page.getByRole("heading", { name: "مغامرات للجميع" })).toBeVisible();
  await page.goto(`${english}/boosts`);
  // The page explains itself by its title; the explanation is behind the info button, in the event's words.
  const intro = page.getByText(/^Double what one stage's missions pay/);
  await expect(intro).toBeHidden();
  // Each info button is named for what it explains, and opens on hover, focus and click, and closes on a click or Escape.
  const tip = page.getByRole("button", { name: /^More information: / }).first();
  await tip.hover();
  await expect(intro).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(intro).toBeHidden();
  await page.mouse.move(0, 0);
  await tip.hover();
  await expect(intro).toBeVisible();
  await tip.click();
  await expect(intro).toBeHidden();
  await tip.click();
  await expect(intro).toBeVisible();
  await page.mouse.move(0, 0);
  await expect(intro).toBeVisible();
  await tip.click();
  await expect(intro).toBeHidden();
  await page.goto(`${english}/boosts`);
  await tip.focus();
  await expect(intro).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(intro).toBeHidden();
  await page.goto(`${arabic}/joining`);
  await expect(page.getByText(/^اجعل مرحلة أو جائزة لمجموعة من اللاعبين فقط/)).toBeAttached();
});
