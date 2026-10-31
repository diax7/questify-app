import { expect, test, type Page } from "@playwright/test";
import { openBuilder } from "#e2e/builder.ts";

/**
 * An event's accent colour, its shop, live polls, maps and agenda switches, and the preview of the player screens (T-602,
 * FR-1009, FR-1022, FR-1023): the accent is picked from a list and kept, the preview shows the event as players will see
 * it in either language, a switched-off feature is missing from it, and opening it writes nothing.
 */

async function openEvent(page: Page, project: string): Promise<string> {
  await openBuilder(page, project);
  const eventUrl = page.url().replace(/\/quests$/, "");
  await page.goto(eventUrl.replace("/ar/", "/en/"));
  return eventUrl.replace("/ar/", "/en/");
}

test("an accent is picked from the list, kept, and drawn on the preview's buttons", async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  const eventUrl = await openEvent(page, info.project.name);

  const colours = page.getByRole("group", { name: "Accent colour" });
  await expect(colours.getByRole("radio")).toHaveCount(7);
  await expect(colours.getByRole("radio", { name: "Questify green" })).toBeChecked();
  await colours.getByRole("radio", { name: "Sky" }).check();
  await expect(colours.getByRole("radio", { name: "Sky" })).toBeChecked();
  await page.reload();
  await expect(page.getByRole("radio", { name: "Sky" })).toBeChecked();

  const writes: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/v1/") && request.method() !== "GET") {
      writes.push(`${request.method()} ${request.url()}`);
    }
  });
  await page.goto(`${eventUrl}/preview`);
  await expect(page.getByRole("heading", { name: "Preview", level: 1 })).toBeVisible();
  const home = page.getByRole("region", { name: "Home" });
  await expect(home).toBeVisible();
  await expect(home.getByText("Scan", { exact: true }).first()).toHaveCSS(
    "background-color",
    "rgb(74, 165, 230)",
  );
  expect(writes).toEqual([]);

  await page.goto(eventUrl);
  await page.getByRole("radio", { name: "Questify green" }).check();
  await page.goto(`${eventUrl}/preview`);
  await expect(
    page.getByRole("region", { name: "Home" }).getByText("Scan", { exact: true }).first(),
  ).toHaveCSS("background-color", "rgb(104, 192, 91)");
});

test("a switched-off feature is missing from the preview, in English and in Arabic", async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  const eventUrl = await openEvent(page, info.project.name);

  await page.goto(`${eventUrl}/preview`);
  await expect(page.getByRole("region", { name: "Rewards" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Home" }).getByText("Agenda")).toBeVisible();
  await expect(page.getByRole("region", { name: "Home" }).getByText("Maps")).toBeVisible();

  await page.goto(eventUrl);
  for (const name of [
    "Show the shop in the event",
    "Show the agenda in the event",
    "Show maps in the event",
  ]) {
    await page.getByRole("checkbox", { name }).uncheck();
    await expect(page.getByRole("checkbox", { name })).not.toBeChecked();
  }
  await page.reload();
  await expect(
    page.getByRole("checkbox", { name: "Show the shop in the event" }),
  ).not.toBeChecked();
  await expect(page.getByRole("checkbox", { name: "Show live polls in the event" })).toBeChecked();

  await page.goto(`${eventUrl}/preview`);
  await expect(page.getByRole("region", { name: "Home" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Rewards" })).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "Home" }).getByText("Rewards", { exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Home" }).getByText("Agenda")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Home" }).getByText("Maps")).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "Quests" }).getByText("Map", { exact: true }),
  ).toHaveCount(0);

  await page.getByRole("radio", { name: "العربية" }).check();
  const home = page.getByRole("region", { name: "الرئيسية" });
  await expect(home).toBeVisible();
  await expect(home).toHaveAttribute("dir", "rtl");
  await expect(home.getByText("ملتقى نجد")).toBeVisible();
  await expect(page.getByRole("region", { name: "الجوائز" })).toHaveCount(0);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});
