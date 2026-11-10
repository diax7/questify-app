import { expect, test, type Page } from "@playwright/test";
import { freshAddress } from "#e2e/mail.ts";
import { CONTROL_PORT } from "#e2e/paths.ts";
import { signInByEmail } from "#e2e/player-web.ts";

const control = `http://127.0.0.1:${CONTROL_PORT}`;

/**
 * One player call the way the web session makes it (`apps/app/src/api/cookie-session.ts`, ADR-821): on a 401, take the
 * browser's `questify.refresh` lock, try once more (another tab may have refreshed), and refresh only when that is a
 * 401 too; then call again. Answers the last status.
 */
const callAsTheApp = (page: Page): Promise<number> =>
  page.evaluate(async () => {
    const path = "/v1/me";
    const me = () => fetch(path, { credentials: "same-origin" });
    const first = await me();
    if (first.status !== 401) {
      return first.status;
    }
    const again = await navigator.locks.request("questify.refresh", async () => {
      const retry = await me();
      if (retry.status !== 401) {
        return retry.status;
      }
      const refreshed = await fetch("/v1/auth/refresh", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      return refreshed.ok ? 0 : refreshed.status;
    });
    return again === 0 ? (await me()).status : again;
  });

/**
 * Two tabs share one cookie jar (T-803 P2): when both find the access token ended at once, exactly one refresh goes
 * out, the API sees no reuse, and both tabs carry on.
 */
test("two tabs that hit an ended access token at once refresh once and both carry on", async ({
  page,
  context,
}, info) => {
  test.skip(info.project.name !== "phone", "one browser size covers the forwarder");
  await freshAddress(page);
  await page.goto("/en/sign-in");
  const email = `web.race.${Date.now()}@najd.test`;
  await signInByEmail(page, email);
  const second = await context.newPage();
  await second.goto("/en/sign-in");

  const refreshes: string[] = [];
  context.on("request", (request) => {
    if (new URL(request.url()).pathname === "/v1/auth/refresh") {
      refreshes.push(request.url());
    }
  });
  const expired = await page.request.post(`${control}/player-access-expired`, { data: { email } });
  expect(await expired.json()).toEqual({ expired: 1 });

  expect(await Promise.all([callAsTheApp(page), callAsTheApp(second)])).toEqual([200, 200]);
  expect(refreshes).toHaveLength(1);
  const audit = await page.request.post(`${control}/player-reuse`, { data: { email } });
  // One issued at sign-up, one by the single rotation, and no reuse ended the family.
  expect(await audit.json()).toEqual({ reuse: 0, refreshTokens: 2 });
});
