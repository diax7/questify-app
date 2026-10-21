import { expect, test } from "@playwright/test";
import { openBuilder } from "#e2e/builder.ts";

/** The event's words (T-117): rename the currency and the player in Arabic and see them where the dashboard uses them. */
test("the organizer renames the currency and the player", async ({ page }, info) => {
  test.setTimeout(90_000);
  await openBuilder(page, info.project.name);
  const eventPage = page.url().replace(/\/quests$/, "");
  await page.goto(eventPage);

  const words = page.getByRole("region", { name: "كلمات الفعالية" });
  const currency = words.getByRole("group", { name: "العملة", exact: true });
  const player = words.getByRole("group", { name: "اللاعب", exact: true });
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
  await words.getByRole("button", { name: "حفظ الكلمات" }).click();
  await expect(words.getByRole("status")).toHaveText("حُفظت الكلمات.");
  await expect(page.getByRole("link", { name: "طلاب" })).toBeVisible();

  await page.reload();
  await expect(currency.getByRole("radio", { name: "جوهرة" })).toBeChecked();
  await page.getByRole("link", { name: "طلاب" }).click();
  await expect(page.getByRole("heading", { name: "طلاب", level: 2 })).toBeVisible();

  await page.goto(`${eventPage.replace("/ar/", "/en/")}/players`);
  await expect(page.getByRole("heading", { name: "Students", level: 2 })).toBeVisible();
});
