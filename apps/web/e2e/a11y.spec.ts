import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { MESSAGES } from "@questify/shared";
import {
  LAYOUT_PAGES,
  PUBLIC_PAGES,
  openPage,
  watchRequests,
  type LayoutIds,
} from "#e2e/layout.ts";
import { control, createEvent, fillShop, startAndFill, type Event } from "#e2e/layout-fill.ts";
import { freshAddress } from "#e2e/mail.ts";
import { openMenu } from "#e2e/nav.ts";

/**
 * The accessibility sweep (T-808, automated part): every page of the layout check (`LAYOUT_PAGES` and `PUBLIC_PAGES`),
 * the unpaired screen, station and kiosk pages, the big screen paired and showing its ranking, and one confirmation dialog, in English and Arabic, on the desktop and
 * the phone project (and on a phone again with the Menu sheet open), read by axe-core against the WCAG 2.1 A and AA
 * rules. Serious, critical and moderate violations fail the test (the best-practice rules too: heading order, landmarks, a
 * level-one heading); minor ones are listed in the output only. The
 * event is filled first, exactly as the layout check does, so the pages show their filled states.
 *
 * `ALLOWED` is the one place a rule may be waived on a page: each entry names the rule, the page (or `*` for the
 * rule on every page) and the reason it cannot be fixed. The list is meant to stay empty or short.
 */
const LANGUAGES = ["en", "ar"] as const;
type Language = (typeof LANGUAGES)[number];
const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];
/** The best-practice rules (landmarks, heading order) are read too, and fail at the same impacts. */
const READ_TAGS = [...WCAG_TAGS, "best-practice"];
const FAILING = new Set(["serious", "critical", "moderate"]);

type Waiver = Readonly<{ rule: string; page: string; reason: string }>;
const ALLOWED: readonly Waiver[] = [];

/** Pages without an account that are not in `PUBLIC_PAGES`: a device waiting for the Devices page to pair it. */
const DEVICE_PAGES = [
  { name: "screen", path: "/screen" },
  { name: "station", path: "/station" },
  { name: "kiosk", path: "/kiosk" },
] as const;
const WAITING = MESSAGES["device.pair.waiting"];

const found: string[] = [];
const notes: string[] = [];

/** Runs axe on the open page and records every serious, critical or moderate violation that is not waived. */
async function sweep(page: Page, where: string, name: string): Promise<void> {
  // A scene fades in over 400 ms; axe reads the colours as they are drawn, so a half-faded row reads as low contrast.
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((one) => one.effect?.getComputedTiming().iterations !== Infinity)
        .map((one) => one.finished.catch(() => null)),
    ),
  );
  const result = await new AxeBuilder({ page }).withTags(READ_TAGS).analyze();
  if (result.incomplete.length > 0) {
    const rules = result.incomplete.map((one) => one.id).join(", ");
    notes.push(`${where}: ${result.incomplete.length} incomplete (axe could not decide): ${rules}`);
  }
  for (const violation of result.violations) {
    const waived = ALLOWED.some(
      (one) => one.rule === violation.id && (one.page === "*" || one.page === name),
    );
    const targets = violation.nodes
      .slice(0, 3)
      .map((node) => `${node.target.join(" ")} ${node.html.slice(0, 90)}`)
      .join(" | ");
    const line = `${where}: ${violation.id} (${violation.impact}) x${violation.nodes.length}: ${targets}`;
    if (!waived && FAILING.has(violation.impact ?? "")) {
      found.push(line);
    } else {
      notes.push(waived ? `waived ${line}` : line);
    }
  }
}

/** One page, opened and read; on a phone again with the Menu sheet open. */
async function readPage(
  page: Page,
  project: string,
  language: Language,
  listed: Readonly<{ name: string; ready: Readonly<Record<Language, string>> }>,
  path: string,
): Promise<void> {
  const where = `${project} ${language} ${listed.name}`;
  await openPage(page, language, path, listed.ready[language], where);
  await sweep(page, where, listed.name);
  if (project === "phone") {
    await openMenu(page);
    await sweep(page, `${where} with the menu open`, listed.name);
  }
}

/** The event page's Delete draft confirmation, open. */
async function readDialog(
  page: Page,
  project: string,
  language: Language,
  ids: Event,
): Promise<void> {
  const ready = LAYOUT_PAGES.find((one) => one.name === "event")?.ready[language] ?? "";
  const where = `${project} ${language} event confirmation dialog`;
  await openPage(
    page,
    language,
    `/organizers/${ids.organizerId}/events/${ids.eventId}`,
    ready,
    where,
  );
  await page
    .getByRole("button", { name: language === "en" ? "Delete draft" : "حذف المسودة" })
    .click();
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await sweep(page, where, "event-dialog");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
}

const PAIRING = /[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{4}/;

/**
 * A big screen paired from the Devices page, read in both languages while it shows the ranking (the first scene). It
 * has its own organizer and event, made as the big-screen spec does: the add-on and the scenes are seeded on a plain
 * live event, which the filled event of the run does not take.
 */
async function readPairedScreen(browser: Browser, project: string): Promise<void> {
  const owner = await browser.newContext();
  const page = await owner.newPage();
  await freshAddress(page);
  const ids = await createEvent(page, project);
  await control(page, "/event-status", { eventId: ids.eventId, status: "live" });
  await control(page, "/big-screen-seed", { eventId: ids.eventId });
  const tag = `${Date.now() % 1_000_000}`;
  await control(page, "/scored", {
    eventId: ids.eventId,
    usernames: [`sara_${tag}`, `khalid_${tag}`, `noura_${tag}`],
    points: [150, 90, 40],
  });
  const tv = await browser.newContext();
  try {
    const screen = await tv.newPage();
    await screen.goto("/en/screen");
    const code = (await screen.getByText(PAIRING).textContent()) ?? "";
    await page.goto(`/en/organizers/${ids.organizerId}/events/${ids.eventId}/devices`);
    await page.getByLabel(MESSAGES["devices.code"].en).fill(code.toLowerCase());
    await page.getByRole("button", { name: MESSAGES["devices.check"].en }).click();
    await page.getByRole("textbox", { name: MESSAGES["devices.label"].en }).fill("Entrance screen");
    await page.getByRole("button", { name: MESSAGES["devices.confirm"].en, exact: true }).click();
    await expect(page.getByText(MESSAGES["devices.done"].en)).toBeVisible();
    for (const language of LANGUAGES) {
      await screen.goto(`/${language}/screen`);
      await expect(screen.getByText(MESSAGES["screen.ranking.title"][language])).toBeVisible({
        timeout: 30_000,
      });
      await sweep(screen, `${project} ${language} screen-ranking`, "screen-ranking");
    }
  } finally {
    await tv.close();
    await owner.close();
  }
}

test("every page passes the WCAG 2.1 A and AA rules of axe-core", async ({
  page,
  browser,
}, info) => {
  test.setTimeout(600_000);
  found.length = 0;
  notes.length = 0;
  page.on("pageerror", (error) => {
    throw error;
  });
  const project = info.project.name;
  await page.setViewportSize(
    project === "phone" ? { width: 360, height: 780 } : { width: 1440, height: 900 },
  );
  await freshAddress(page);
  watchRequests(page);

  for (const listed of PUBLIC_PAGES) {
    for (const language of LANGUAGES) {
      await readPage(page, project, language, listed, listed.path);
    }
  }
  for (const device of DEVICE_PAGES) {
    for (const language of LANGUAGES) {
      await readPage(page, project, language, { name: device.name, ready: WAITING }, device.path);
    }
  }

  const created = await createEvent(page, project);
  await fillShop(page, created);
  const draftIds: LayoutIds = {
    ...created,
    joinCode: "",
    ticketId: "",
    campaignId: "",
    playerId: "",
  };
  for (const listed of LAYOUT_PAGES.filter((one) => one.phase === "draft")) {
    for (const language of LANGUAGES) {
      await readPage(page, project, language, listed, listed.path(draftIds));
    }
  }
  for (const language of LANGUAGES) {
    await readDialog(page, project, language, created);
  }

  const ids = await startAndFill(page, created);
  for (const listed of LAYOUT_PAGES.filter((one) => one.phase !== "draft")) {
    for (const language of LANGUAGES) {
      await readPage(page, project, language, listed, listed.path(ids));
    }
  }
  await readPairedScreen(browser, project);

  process.stdout.write(`${notes.length} other findings (not failures):\n${notes.join("\n")}\n`);
  expect(found, "serious, critical or moderate accessibility violations").toEqual([]);
});
