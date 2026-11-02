import { expect, test, type Page } from "@playwright/test";
import { openBuilder } from "#e2e/builder.ts";

/**
 * An event's bar and Home layout (T-606, FR-1749, FR-1750, FR-1764): a preset applies in one tap, the rows move with the
 * buttons, the keyboard or a drag, an item hides, the preview follows before anything is saved, Home, the scan button and
 * Profile cannot be hidden (the page and the server both say no), and a switched-off feature stays off whatever the layout
 * says. Home's own words (T-610): a text card and a banner slide are written, checked, previewed, saved and removed, and
 * Reset to default keeps them.
 */

async function openEvent(page: Page, project: string): Promise<string> {
  await openBuilder(page, project);
  const eventUrl = page.url().replace(/\/quests$/, "");
  await page.goto(eventUrl.replace("/ar/", "/en/"));
  return eventUrl.replace("/ar/", "/en/");
}

const region = (page: Page, name: string) => page.getByRole("region", { name, exact: true });
const rowOf = (list: ReturnType<typeof region>, label: string) =>
  list.getByRole("listitem").filter({ hasText: label });

test("a preset applies in one tap, shows on the preview, and is kept", async ({ page }, info) => {
  test.setTimeout(120_000);
  const eventUrl = await openEvent(page, info.project.name);
  await page.goto(`${eventUrl}/layout`);
  await expect(page.getByRole("heading", { name: "Layout", level: 1 })).toBeVisible();

  const home = region(page, "Home");
  const previewBar = home.getByRole("list", { name: "Bottom bar" }).getByRole("listitem");
  await expect(page.getByRole("radio", { name: "Questify default" })).toBeChecked();
  await expect(previewBar).toHaveText(["Home", "Quests", "Scan", "Rewards", "Profile"]);

  await page.getByRole("radio", { name: "Essentials" }).check();
  await expect(page.getByText("Layout saved.")).toBeVisible();
  await expect(previewBar).toHaveText(["Home", "Quests", "Scan", "Profile"]);
  await expect(home.getByText("Sponsors", { exact: true })).toHaveCount(0);

  await page.reload();
  await expect(page.getByRole("radio", { name: "Essentials" })).toBeChecked();
  await expect(previewBar).toHaveText(["Home", "Quests", "Scan", "Profile"]);

  await page.getByRole("radio", { name: "Prizes first" }).check();
  await expect(page.getByText("Layout saved.")).toBeVisible();
  await expect(previewBar).toHaveText(["Home", "Rewards", "Scan", "Quests", "Profile"]);
  await page.getByRole("radio", { name: "Questify default" }).check();
  await expect(previewBar).toHaveText(["Home", "Quests", "Scan", "Rewards", "Profile"]);
});

test("rows move with the buttons and the keyboard, hide, follow on the preview, and save", async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  const eventUrl = await openEvent(page, info.project.name);
  await page.goto(`${eventUrl}/layout`);

  const bar = region(page, "Bottom bar");
  const blocks = region(page, "Home screen");
  const preview = region(page, "Home");
  const previewBar = preview.getByRole("list", { name: "Bottom bar" }).getByRole("listitem");
  const save = page.getByRole("button", { name: "Save layout" });
  await expect(save).toBeDisabled();

  const rewards = rowOf(bar, "Rewards");
  await rewards.getByRole("button", { name: "Move Rewards earlier" }).click();
  await rewards.getByRole("button", { name: "Move Rewards earlier" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("Rewards moved to position 2 of 5")).toBeAttached();
  await expect(bar.getByRole("listitem")).toContainText([
    "Home",
    "Rewards",
    "Quests",
    "Scan",
    "Profile",
  ]);
  await expect(previewBar).toHaveText(["Home", "Rewards", "Quests", "Scan", "Profile"]);
  await expect(save).toBeEnabled();

  await rowOf(blocks, "Sponsors").getByRole("checkbox", { name: "Show Sponsors" }).uncheck();
  const previewBlocks = preview.getByRole("list", { name: "Home screen" });
  await expect(previewBlocks.getByText("Sponsors", { exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: "Discard changes" }).click();
  await expect(save).toBeDisabled();
  await expect(previewBar).toHaveText(["Home", "Quests", "Scan", "Rewards", "Profile"]);
  await expect(previewBlocks.getByText("Sponsors", { exact: true })).toBeVisible();

  await rowOf(bar, "Rewards").getByRole("button", { name: "Move Rewards earlier" }).click();
  await rowOf(blocks, "Sponsors").getByRole("checkbox", { name: "Show Sponsors" }).uncheck();
  await save.click();
  await expect(page.getByText("Layout saved.")).toBeVisible();
  await expect(page.getByRole("radio", { name: "Questify default" })).not.toBeChecked();

  await page.reload();
  await expect(bar.getByRole("listitem")).toContainText([
    "Home",
    "Quests",
    "Rewards",
    "Scan",
    "Profile",
  ]);
  await expect(
    rowOf(blocks, "Sponsors").getByRole("checkbox", { name: "Show Sponsors" }),
  ).not.toBeChecked();
  await expect(previewBar).toHaveText(["Home", "Quests", "Rewards", "Scan", "Profile"]);
});

test("a row can be dragged to another place", async ({ page }, info) => {
  test.skip(
    info.project.name === "phone",
    "a phone arranges with the move buttons, not a mouse drag",
  );
  test.setTimeout(120_000);
  const eventUrl = await openEvent(page, info.project.name);
  await page.goto(`${eventUrl}/layout`);
  const blocks = region(page, "Home screen");
  await rowOf(blocks, "Sponsors").dragTo(rowOf(blocks, "Day streak"));
  await expect(blocks.getByRole("listitem")).toContainText([
    "Banner",
    "Event countdown",
    "Points and balance",
    "Sponsors",
    "Day streak",
    "Announcements and shortcuts",
  ]);
  await expect(page.getByRole("button", { name: "Save layout" })).toBeEnabled();
});

test("Home, the scan button and Profile cannot be hidden, on the page or at the server", async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  const eventUrl = await openEvent(page, info.project.name);
  await page.goto(`${eventUrl}/layout`);

  const bar = region(page, "Bottom bar");
  const blocks = region(page, "Home screen");
  for (const [list, label] of [
    [bar, "Home"],
    [bar, "Scan"],
    [bar, "Profile"],
    [blocks, "Points and balance"],
    [blocks, "Prizes and results"],
    [blocks, "History and event info"],
  ] as const) {
    const row = rowOf(list, label);
    await expect(row).toContainText("Always shown");
    const shown = row.getByRole("checkbox", { name: `Show ${label}` });
    await expect(shown).toBeChecked();
    await expect(shown).toBeDisabled();
  }
  await expect(rowOf(bar, "Quests").getByRole("checkbox", { name: "Show Quests" })).toBeEnabled();

  const [organizerId, eventId] =
    /organizers\/([^/]+)\/events\/([^/]+)/.exec(page.url())?.slice(1) ?? [];
  const hidesScanner = {
    bar: { order: ["index", "quests", "scan", "rewards", "profile"], hidden: ["scan"] },
    home: {
      order: [
        "banner",
        "countdown",
        "standing",
        "streak",
        "announcements",
        "sponsors",
        "prizes",
        "live",
        "goal",
        "featured",
        "ranking",
        "podium",
        "upNext",
        "quickLinks",
        "page",
        "links",
      ],
      hidden: [],
    },
    info: {
      order: ["about", "venue", "when", "schedule", "faq", "contacts", "rules"],
      hidden: [],
    },
    content: {
      banner: [],
      quickLinks: [],
      featured: null,
      cards: [],
      about: { ar: "", en: "" },
      faq: [],
      contacts: [],
      page: null,
    },
    looks: {
      ranking: { layout: "list", scores: "shown" },
      quests: "list",
      shop: "list",
    },
  };
  const answer = await page.evaluate(
    async ([url, body]) => {
      const response = await fetch(url as string, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await response.json()) as { code?: string };
      return [response.status, json.code];
    },
    [`/v1/organizers/${organizerId}/events/${eventId}/layout`, hidesScanner],
  );
  expect(answer).toEqual([422, "layout_item_protected"]);
  await page.reload();
  await expect(page.getByRole("radio", { name: "Questify default" })).toBeChecked();
  await expect(
    rowOf(region(page, "Bottom bar"), "Scan").getByRole("checkbox", { name: "Show Scan" }),
  ).toBeChecked();
});

test("a switched-off shop stays off the bar whatever the layout says", async ({ page }, info) => {
  test.setTimeout(120_000);
  const eventUrl = await openEvent(page, info.project.name);
  await page.getByRole("checkbox", { name: "Show the shop in the event" }).uncheck();
  await expect(
    page.getByRole("checkbox", { name: "Show the shop in the event" }),
  ).not.toBeChecked();
  await page.goto(`${eventUrl}/layout`);

  const rewards = rowOf(region(page, "Bottom bar"), "Rewards");
  await expect(rewards).toContainText("Switched off for the event");
  await expect(rewards.getByRole("checkbox", { name: "Show Rewards" })).toBeChecked();
  const previewBar = region(page, "Home")
    .getByRole("list", { name: "Bottom bar" })
    .getByRole("listitem");
  await expect(previewBar).toHaveText(["Home", "Quests", "Scan", "Profile"]);
  await rewards.getByRole("button", { name: "Move Rewards earlier" }).click();
  await expect(previewBar).toHaveText(["Home", "Quests", "Scan", "Profile"]);
});

test("the page reads right to left in Arabic without sideways scrolling", async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  const eventUrl = await openEvent(page, info.project.name);
  await page.goto(`${eventUrl.replace("/en/", "/ar/")}/layout`);
  await expect(page.getByRole("heading", { name: "التخطيط", level: 1 })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByRole("radio", { name: "الأساسيات" })).toBeVisible();
  const bar = region(page, "الشريط السفلي");
  await expect(bar.getByRole("listitem")).toHaveCount(5);
  await expect(
    rowOf(bar, "الرئيسية").getByRole("checkbox", { name: "إظهار الرئيسية" }),
  ).toBeDisabled();
  const infoList = region(page, "صفحة معلومات الفعالية");
  await expect(infoList.getByRole("listitem")).toHaveCount(7);
  await rowOf(infoList, "الأسئلة الشائعة")
    .getByRole("button", { name: "تعديل الأسئلة الشائعة" })
    .click();
  await page.getByRole("button", { name: "إضافة سؤال" }).click();
  await expect(page.getByLabel("السؤال (العربية)")).toBeVisible();
  await rowOf(region(page, "الشاشة الرئيسية"), "الصفحة الإضافية")
    .getByRole("button", { name: "تعديل الصفحة الإضافية" })
    .click();
  await page.getByRole("button", { name: "إضافة الصفحة" }).click();
  await expect(page.getByRole("button", { name: "إضافة قائمة" })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

test("the organizer writes a text card and a banner slide, sees them on the preview, saves, and removes the card", async ({
  page,
}, info) => {
  test.setTimeout(180_000);
  const eventUrl = await openEvent(page, info.project.name);
  await page.goto(`${eventUrl}/layout`);

  const blocks = region(page, "Home screen");
  const previewBlocks = region(page, "Home").getByRole("list", { name: "Home screen" });
  const editor = page.getByRole("region", { name: /^Editing:/ });
  const save = page.getByRole("button", { name: "Save layout" });
  const saved = page.getByText("Layout saved.");

  await page.getByRole("button", { name: "Add text card" }).click();
  await expect(save).toBeDisabled();
  await expect(page.getByText("Card 1 needs text in Arabic or English.")).toBeVisible();
  await editor.getByLabel("Title (English)", { exact: true }).fill("Welcome");
  await editor.getByLabel("Text (English)").fill("Registration is in the main hall");
  await editor.getByLabel("Text (Arabic)").fill("التسجيل في القاعة الرئيسية");
  await expect(save).toBeEnabled();
  await expect(previewBlocks.getByText("Welcome", { exact: true })).toBeVisible();
  await expect(previewBlocks.getByText("Registration is in the main hall")).toBeVisible();
  await expect(rowOf(blocks, "Welcome")).toBeVisible();
  await editor.getByRole("button", { name: "Done editing" }).click();
  await expect(editor).toHaveCount(0);

  await rowOf(blocks, "Banner").getByRole("button", { name: "Edit Banner" }).click();
  await expect(previewBlocks.getByText("Big day")).toHaveCount(0);
  await page.getByRole("button", { name: "Add slide" }).click();
  await expect(page.getByText("Slide 1 needs a title in Arabic or English.")).toBeVisible();
  await editor.getByLabel("Title (English)", { exact: true }).fill("Big day");
  await editor.getByLabel("Tap opens").selectOption("link");
  await editor.getByLabel("Link", { exact: true }).fill("javascript:alert(1)");
  await expect(page.getByText("Enter a full link that starts with https.")).toBeVisible();
  await expect(save).toBeDisabled();
  await editor.getByLabel("Link", { exact: true }).fill("https://example.com/day");
  await expect(save).toBeEnabled();
  await expect(previewBlocks.getByText("Big day")).toBeVisible();

  await save.click();
  await expect(saved).toBeVisible();
  await page.reload();
  await expect(rowOf(blocks, "Welcome")).toBeVisible();
  await expect(previewBlocks.getByText("Big day")).toBeVisible();
  await expect(previewBlocks.getByText("Registration is in the main hall")).toBeVisible();

  await rowOf(blocks, "Welcome").getByRole("button", { name: "Remove Welcome" }).click();
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(rowOf(blocks, "Welcome")).toHaveCount(0);
  await expect(previewBlocks.getByText("Welcome", { exact: true })).toHaveCount(0);
  await save.click();
  await expect(saved).toBeVisible();
  await page.reload();
  await expect(rowOf(blocks, "Welcome")).toHaveCount(0);
  await expect(previewBlocks.getByText("Big day")).toBeVisible();
});

test("Reset to default restores Questify's order after a confirmation and keeps the organizer's words", async ({
  page,
}, info) => {
  test.setTimeout(180_000);
  const eventUrl = await openEvent(page, info.project.name);
  await page.goto(`${eventUrl}/layout`);

  const blocks = region(page, "Home screen");
  const save = page.getByRole("button", { name: "Save layout" });
  await page.getByRole("button", { name: "Add text card" }).click();
  await page.getByLabel("Text (English)").fill("Doors open at nine");
  await page.getByRole("button", { name: "Done editing" }).click();
  await rowOf(blocks, "Sponsors").getByRole("button", { name: "Move Sponsors earlier" }).click();
  await save.click();
  await expect(page.getByText("Layout saved.")).toBeVisible();
  await expect(page.getByRole("radio", { name: "Questify default" })).not.toBeChecked();

  await page.getByRole("button", { name: "Reset to default" }).click();
  await expect(page.getByText("Reset Home to Questify's default?")).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("radio", { name: "Questify default" })).not.toBeChecked();

  await page.getByRole("button", { name: "Reset to default" }).click();
  await page.getByRole("button", { name: "Reset", exact: true }).click();
  await expect(page.getByText("Layout saved.")).toBeVisible();
  await expect(page.getByRole("radio", { name: "Questify default" })).toBeChecked();
  await expect(blocks.getByRole("listitem")).toContainText([
    "Banner",
    "Event countdown",
    "Points and balance",
    "Day streak",
    "Announcements and shortcuts",
    "Sponsors",
  ]);
  await expect(blocks.getByRole("listitem").last()).toContainText("Text card");
});

test("the ranking, Quests and Rewards layouts are chosen, previewed, saved and kept", async ({
  page,
}, info) => {
  test.setTimeout(180_000);
  const eventUrl = await openEvent(page, info.project.name);
  await page.goto(`${eventUrl}/layout`);

  const rankingLayout = page.getByRole("group", { name: "Ranking layout" });
  const rankingShows = page.getByRole("group", { name: "Ranking shows" });
  const questsLayout = page.getByRole("group", { name: "Quests layout" });
  const rewardsLayout = page.getByRole("group", { name: "Rewards layout" });
  const ranking = region(page, "Ranking");
  const save = page.getByRole("button", { name: "Save layout" });

  await expect(rankingLayout.getByRole("radio", { name: "List" })).toBeChecked();
  await expect(rankingShows.getByRole("radio", { name: "Scores and places" })).toBeChecked();
  await expect(questsLayout.getByRole("radio", { name: "List" })).toBeChecked();
  await expect(rewardsLayout.getByRole("radio", { name: "List" })).toBeChecked();
  await expect(save).toBeDisabled();

  await rankingLayout.getByRole("radio", { name: "Podium" }).check();
  await expect(ranking.getByRole("group", { name: "Podium" })).toBeVisible();
  await expect(ranking.getByText("@sara")).toBeVisible();
  await expect(ranking.getByText("1,240")).toBeVisible();
  await rankingShows.getByRole("radio", { name: "Places only" }).check();
  await expect(ranking.getByText("@sara")).toBeVisible();
  await expect(ranking.getByText("1,240")).toHaveCount(0);
  await expect(ranking.getByText("720", { exact: true })).toHaveCount(0);

  await questsLayout.getByRole("radio", { name: "Grid" }).check();
  await expect(region(page, "Quests")).toBeVisible();
  await rewardsLayout.getByRole("radio", { name: "Grid" }).check();
  await expect(region(page, "Rewards")).toBeVisible();

  await expect(save).toBeEnabled();
  await save.click();
  await expect(page.getByText("Layout saved.")).toBeVisible();

  await page.reload();
  await expect(rankingLayout.getByRole("radio", { name: "Podium" })).toBeChecked();
  await expect(rankingShows.getByRole("radio", { name: "Places only" })).toBeChecked();
  await expect(questsLayout.getByRole("radio", { name: "Grid" })).toBeChecked();
  await expect(rewardsLayout.getByRole("radio", { name: "Grid" })).toBeChecked();
  await expect(save).toBeDisabled();
  await page.getByRole("button", { name: "Ranking", exact: true }).click();
  await expect(ranking.getByRole("group", { name: "Podium" })).toBeVisible();
  await expect(ranking.getByText("1,240")).toHaveCount(0);

  // A preset arranges the blocks and leaves how the screens are drawn alone.
  await page.getByRole("radio", { name: "Essentials" }).check();
  await expect(page.getByText("Layout saved.")).toBeVisible();
  await expect(rankingLayout.getByRole("radio", { name: "Podium" })).toBeChecked();
  await expect(rewardsLayout.getByRole("radio", { name: "Grid" })).toBeChecked();
});

test("the organizer orders the info page, writes About, a question, a contact and the extra page, sees them on the preview, saves, and removes the page", async ({
  page,
}, info) => {
  test.setTimeout(240_000);
  const eventUrl = await openEvent(page, info.project.name);
  await page.goto(`${eventUrl}/layout`);

  const sections = region(page, "Event info page");
  const blocks = region(page, "Home screen");
  const infoScreen = region(page, "About the event");
  const infoLines = infoScreen.getByRole("list", { name: "Event info page" }).getByRole("listitem");
  const editor = page.getByRole("region", { name: /^Editing:/ });
  const save = page.getByRole("button", { name: "Save layout" });
  const saved = page.getByText("Layout saved.");
  const done = editor.getByRole("button", { name: "Done editing" });

  await expect(sections.getByRole("listitem")).toContainText([
    "About",
    "Venue",
    "When",
    "Schedule link",
    "FAQ",
    "Contact",
    "Official rules",
  ]);
  await expect(
    rowOf(sections, "Official rules").getByRole("checkbox", { name: "Show Official rules" }),
  ).toBeDisabled();

  await rowOf(sections, "About").getByRole("button", { name: "Edit About" }).click();
  await editor.getByLabel("Text (English)").fill("A day of games for everyone");
  await done.click();

  await rowOf(sections, "FAQ").getByRole("button", { name: "Edit FAQ" }).click();
  await page.getByRole("button", { name: "Add question" }).click();
  await expect(save).toBeDisabled();
  await expect(
    page.getByText("Question 1 needs a question and an answer in Arabic or English."),
  ).toBeVisible();
  await editor.getByLabel("Question (English)").fill("Is parking free?");
  await editor.getByLabel("Answer (English)").fill("Yes, in lot B.");
  await expect(save).toBeEnabled();
  await done.click();

  await rowOf(sections, "Contact").getByRole("button", { name: "Edit Contact" }).click();
  await page.getByRole("button", { name: "Add contact" }).click();
  await expect(page.getByText("Contact 1 needs a name in Arabic or English.")).toBeVisible();
  await editor.getByLabel("Label (English)").fill("Front desk");
  await editor.getByLabel("Phone number").fill("tel:123");
  await expect(
    page.getByText(
      "Contact 1 needs an email address, a phone number or a full link that starts with https.",
    ),
  ).toBeVisible();
  await expect(save).toBeDisabled();
  await editor.getByLabel("Phone number").fill("050 123 4567");
  await expect(save).toBeEnabled();
  await done.click();

  await rowOf(sections, "Contact").getByRole("button", { name: "Move Contact earlier" }).click();
  await expect(sections.getByRole("listitem")).toContainText([
    "About",
    "Venue",
    "When",
    "Schedule link",
    "Contact",
    "FAQ",
    "Official rules",
  ]);
  await page.getByRole("button", { name: "About the event", exact: true }).click();
  // The event has no rules, so the preview draws no "Official rules" row (as the app does).
  await expect(infoLines).toContainText(["About", "When", "Contact", "FAQ"]);
  await expect(infoLines.filter({ hasText: "Official rules" })).toHaveCount(0);
  await expect(infoScreen.getByText("A day of games for everyone")).toBeVisible();
  await expect(infoScreen.getByText("Is parking free?")).toBeVisible();
  await expect(infoScreen.getByText("Front desk")).toBeVisible();

  await rowOf(blocks, "Extra page").getByRole("button", { name: "Edit Extra page" }).click();
  await page.getByRole("button", { name: "Add the page" }).click();
  await expect(page.getByText("The page needs a title in Arabic or English.")).toBeVisible();
  await editor.getByLabel("Title (English)", { exact: true }).fill("Venue rules");
  await expect(
    page.getByText("Part 1 of the page needs text, or a full link that starts with https."),
  ).toBeVisible();
  await editor.getByLabel("Text (English)").fill("No bags inside the hall.");
  await page.getByRole("button", { name: "Add list" }).click();
  await editor.getByLabel("Items (English), one per line").fill("ID card\nTicket");
  await page.getByRole("button", { name: "Add link" }).click();
  await editor.getByLabel("Label (English)").fill("Hall map");
  await editor.getByLabel("Link", { exact: true }).fill("http://example.com/map");
  await expect(
    page.getByText("Part 3 of the page needs text, or a full link that starts with https."),
  ).toBeVisible();
  await editor.getByLabel("Link", { exact: true }).fill("https://example.com/map");
  await expect(save).toBeEnabled();
  await done.click();

  await page.getByRole("button", { name: "Extra page", exact: true }).click();
  const extra = region(page, "Extra page").filter({ hasText: "Venue rules" });
  await expect(extra.getByText("No bags inside the hall.")).toBeVisible();
  await expect(extra.getByText("ID card")).toBeVisible();
  await expect(extra.getByText("Hall map")).toBeVisible();
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await expect(
    region(page, "Home").getByRole("list", { name: "Home screen" }).getByText("Venue rules"),
  ).toBeVisible();

  await save.click();
  await expect(saved).toBeVisible();
  await page.reload();
  await expect(sections.getByRole("listitem")).toContainText([
    "About",
    "Venue",
    "When",
    "Schedule link",
    "Contact",
    "FAQ",
    "Official rules",
  ]);
  await page.getByRole("button", { name: "Extra page", exact: true }).click();
  await expect(region(page, "Extra page").getByText("Venue rules")).toBeVisible();

  await rowOf(blocks, "Extra page").getByRole("button", { name: "Edit Extra page" }).click();
  await page.getByRole("button", { name: "Remove the page" }).click();
  await expect(page.getByText("Remove the extra page?")).toBeVisible();
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(page.getByRole("button", { name: "Extra page", exact: true })).toHaveCount(0);
  await save.click();
  await expect(saved).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "Extra page", exact: true })).toHaveCount(0);
  await expect(sections.getByRole("listitem")).toContainText(["Contact", "FAQ"]);
});
