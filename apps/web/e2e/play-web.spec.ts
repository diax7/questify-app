import { expect, test, type Page } from "@playwright/test";
import {
  createTranslator,
  DEFAULT_TERMS,
  MESSAGES,
  wordParams,
  type Language,
  type MessageKey,
} from "@questify/shared";
import { codeFor, freshAddress } from "#e2e/mail.ts";
import { CONTROL_PORT } from "#e2e/paths.ts";
import { meStatus } from "#e2e/player-web.ts";

const translate = createTranslator(MESSAGES);

/** One screen text in this language, the event words at their defaults (what an event with no custom words shows). */
const words = (key: MessageKey, language: Language): string =>
  translate(key, language, wordParams(DEFAULT_TERMS, language));

/**
 * The player web build at `/play` (T-803 P3, FR-1816), driving the real app and its real session: the join card, the
 * email sign-in through the forwarder's cookie, the new account, the event, a quest played for points, a reload that
 * keeps the player signed in, a quest that needs the phone app, and the page direction. The page runs under its own
 * content-security policy, so any violation fails the test. One phone-size browser covers it, in each language.
 */
for (const language of ["en", "ar"] as const) {
  test.describe(`the player web build in ${language}`, () => {
    test.use({ locale: language === "ar" ? "ar-SA" : "en-US" });

    test(`a player joins an event, plays a quest and reloads signed in (${language})`, async ({
      page,
    }, info) => {
      test.skip(info.project.name !== "phone", "the player web build is for phone browsers");
      test.setTimeout(45_000);
      const violations = watchPolicy(page);
      await freshAddress(page);
      const key = `PW${language.toUpperCase()}${Date.now() % 1_000_000}`;
      const seeded = await page.request.post(`http://127.0.0.1:${CONTROL_PORT}/play-web-seed`, {
        data: { key },
      });
      expect(seeded.status()).toBe(204);
      const eventName = language === "ar" ? `مهرجان الويب ${key}` : `Web Fest ${key}`;
      const text = (name: MessageKey): string => words(name, language);

      await onlyTagQuest(page);

      // Arabic starts left to right and reloads once into the right-to-left layout (the browser's restart, ADR-101).
      await page.goto(`/play/join/${key}`);
      await expect(page.locator("html")).toHaveAttribute("dir", language === "ar" ? "rtl" : "ltr");
      await expect(page.locator("html")).toHaveAttribute("lang", language);
      await page.getByText(text("joinCard.join"), { exact: true }).last().click();

      await page.getByText(text("signIn.accept")).click();
      await page.getByText(text("signIn.useEmail")).click();
      const email = `play.web.${language}.${Date.now()}@najd.test`;
      await page.getByLabel(text("signIn.email"), { exact: true }).fill(email);
      await page.getByText(text("signIn.sendCode")).click();
      await page.getByLabel(text("signIn.code"), { exact: true }).fill(await codeFor(email));
      await page.getByText(text("signIn.verify"), { exact: true }).click();

      // A new address makes a new account: name, year, avatar.
      await page
        .getByLabel(text("signIn.username"))
        .fill(`web${language}${Date.now() % 1_000_000}`);
      await page.getByLabel(text("signIn.birthYear")).fill("1995");
      await page.getByText(text("avatar.fox"), { exact: true }).click();
      await page.getByText(text("signIn.create"), { exact: true }).click();
      await page.getByText(text("joinCard.openEvent")).click();
      await page.getByText(text("onboarding.skip"), { exact: true }).click();

      // The event home. The Quests tab lists both quests; the code quest pays its 25 points.
      await expect(page.getByText(eventName).locator("visible=true").first()).toBeVisible();
      await page.getByText(text("nav.quests"), { exact: true }).last().click();
      await page
        .getByRole("button", { name: language === "ar" ? /الكلمة السرية/u : /Secret word/u })
        .click();
      await page.getByLabel(text("questsTab.codeLabel"), { exact: true }).fill("PLAY42");
      await page.getByText(text("questsTab.submit"), { exact: true }).click();
      await expect(page.getByText(/\+25/u).first()).toBeVisible();
      await page.getByText(text("common.close"), { exact: true }).last().click();

      // A quest only an NFC tag can finish says it needs the phone app, and offers no scan button.
      await page
        .getByRole("button", { name: language === "ar" ? /المس العلامة/u : /Tap the tag/u })
        .click();
      await expect(page.getByText(text("quests.needsApp"), { exact: true })).toBeVisible();
      await expect(page.getByText(text("quests.needsAppHint"), { exact: true })).toBeVisible();
      await expect(page.getByText(text("questsTab.scan"), { exact: true })).toHaveCount(0);

      // The cookie, not the page, holds the session: a reload comes back signed in on the same event, with the points it earned.
      await page.reload();
      await expect(page).toHaveURL(/\/play\/event\//u);
      await expect(page.getByText(eventName).locator("visible=true").first()).toBeVisible();
      // The reload keeps the Quests tab: the category shows 25 of the 35 points, and the code quest is done.
      await expect(page.getByRole("button", { name: /\b25\b.*\b35\b/u })).toBeVisible();

      await expect(page.locator("html")).toHaveAttribute("dir", language === "ar" ? "rtl" : "ltr");
      expect(await page.evaluate(() => document.cookie)).not.toContain("qs_player");

      // Signing out asks first in the app's own dialog (a browser may block confirm(), which would cancel in silence):
      // Cancel keeps the player signed in, Sign out ends the session and removes the cookie.
      const native: string[] = [];
      page.on("dialog", (dialog) => {
        native.push(dialog.message());
        void dialog.dismiss();
      });
      await page.getByText(text("nav.profile"), { exact: true }).last().click();
      const signOut = page.getByRole("button", { name: text("signOut.confirm"), exact: true });
      await signOut.first().click();
      await expect(page.getByText(text("signOut.title"), { exact: true })).toBeVisible();
      await page.getByRole("button", { name: text("common.cancel"), exact: true }).click();
      await expect(page.getByText(text("signOut.title"), { exact: true })).toHaveCount(0);
      expect(await meStatus(page)).toBe(200);
      await signOut.first().click();
      await signOut.last().click();
      await expect.poll(() => meStatus(page)).toBe(401);
      expect(native).toEqual([]);
      expect(violations).toEqual([]);
    });
  });
}

test("/play is served with its own policy, no cache for the page and a year for its hashed files", async ({
  request,
}, info) => {
  test.skip(info.project.name !== "phone", "the player web build is for phone browsers");
  const page = await request.get("/play");
  expect(page.status()).toBe(200);
  const headers = page.headers();
  expect(headers["content-security-policy"]).toContain("script-src 'self' 'wasm-unsafe-eval';");
  expect(headers["content-security-policy"]).not.toContain("nonce-");
  expect(headers["permissions-policy"]).toContain("camera=(self)");
  expect(headers["permissions-policy"]).toContain("geolocation=(self)");
  expect(headers["cache-control"]).toBe("no-store");
  // A screen of the app is the same page; no language redirect.
  expect((await request.get("/play/event/anything")).status()).toBe(200);
  expect((await request.get("/play/index.html", { maxRedirects: 0 })).status()).toBe(307);
  expect((await request.get("/play/missing.js")).status()).toBe(404);
  // The page names its script: that file and the decoder's wasm answer from this origin.
  const script = /src="(\/play\/_expo\/[^"]+\.js)"/u.exec(await page.text())?.[1] ?? "";
  const bundle = await request.get(script);
  expect(bundle.status()).toBe(200);
  expect(bundle.headers()["cache-control"]).toContain("immutable");
  const decoder = await request.get("/zxing/zxing_reader-3.1.6.wasm");
  expect(decoder.status()).toBe(200);
  expect(decoder.headers()["content-type"]).toContain("application/wasm");
  // The dashboard keeps its own policy and no location.
  const dashboard = await request.get("/en/sign-in");
  expect(dashboard.headers()["content-security-policy"]).toContain("'strict-dynamic'");
  expect(dashboard.headers()["permissions-policy"]).toContain("geolocation=()");
});

/**
 * The database never stores a quest that only an NFC tag verifies (a tag always comes with the quest's QR code,
 * `quest_verification_known`), so the quest list answer is changed on the way to the page: the seeded quest that offers a
 * tag and a QR code arrives as tag-only, which is the case the app's note is for. Everything else is the real answer.
 */
async function onlyTagQuest(page: Page): Promise<void> {
  await page.route(/\/v1\/events\/[^/]+\/quests(\?|$)/u, async (route) => {
    const answer = await route.fetch();
    const body = (await answer.json()) as {
      categories: { quests: { title: { en: string }; verification?: string[] }[] }[];
    };
    for (const quest of body.categories.flatMap((category) => category.quests)) {
      if (quest.title.en === "Tap the tag") {
        quest.verification = ["nfc"];
      }
    }
    await route.fulfill({ response: answer, json: body });
  });
}

/** Content-security-policy violations the page reports (to the console and as events), for the test to end on. */
function watchPolicy(page: Page): string[] {
  const violations: string[] = [];
  page.on("console", (message) => {
    if (/content security policy/iu.test(message.text())) {
      violations.push(message.text());
    }
  });
  page.on("pageerror", (error) => {
    violations.push(`page error: ${error.message}`);
  });
  return violations;
}
