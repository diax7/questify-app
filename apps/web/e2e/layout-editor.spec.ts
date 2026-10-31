import { expect, test, type Page } from "@playwright/test";
import { openBuilder } from "#e2e/builder.ts";

/**
 * An event's bar and Home layout (T-606, FR-1749, FR-1750, FR-1764): a preset applies in one tap, the rows move with the
 * buttons, the keyboard or a drag, an item hides, the preview follows before anything is saved, Home, the scan button and
 * Profile cannot be hidden (the page and the server both say no), and a switched-off feature stays off whatever the layout
 * says.
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
    "Countdown",
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
        "countdown",
        "standing",
        "streak",
        "announcements",
        "sponsors",
        "prizes",
        "live",
        "goal",
        "ranking",
        "upNext",
        "links",
      ],
      hidden: [],
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
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});
