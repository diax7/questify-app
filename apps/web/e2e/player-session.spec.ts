import { expect, test, type BrowserContext } from "@playwright/test";
import { freshAddress } from "#e2e/mail.ts";
import { CONTROL_PORT } from "#e2e/paths.ts";
import { meStatus, postFromPage, signInByEmail } from "#e2e/player-web.ts";

const COOKIE = "__Host-qs_player";
const DAY_SECONDS = 86_400;

const playerCookie = async (context: BrowserContext) =>
  (await context.cookies()).find((cookie) => cookie.name === COOKIE);

/**
 * The player's web session (T-803 P2, ADR-818): the forwarder keeps the tokens in a host-only HttpOnly cookie, takes
 * them out of every answer, rotates it on refresh, ends it on a reused refresh token and on logout, and refuses a
 * write from another origin. The `/play` screens come with P3 (`play-web.spec.ts`); this drives the forwarder from a
 * page on the web origin.
 */
test("the player's web session lives in an HttpOnly cookie the page never sees", async ({
  page,
  context,
}, info) => {
  test.skip(info.project.name !== "phone", "one browser size covers the forwarder");
  await freshAddress(page);
  await page.goto("/en/sign-in");
  const email = `web.session.${Date.now()}@najd.test`;

  const first = await signInByEmail(page, email);
  expect(first.answer.raw).not.toMatch(/accessToken|refreshToken/u);
  expect(first.answer.body).toMatchObject({ signedIn: true });
  const signedUp = await playerCookie(context);
  expect(signedUp).toMatchObject({ httpOnly: true, secure: true, sameSite: "Strict", path: "/" });
  expect(signedUp?.value).toMatch(/^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/u);
  expect(first.answer.raw).not.toContain(signedUp?.value.split(".")[0] ?? "-");
  const lifetime = (signedUp?.expires ?? 0) - Date.now() / 1000;
  expect(lifetime).toBeGreaterThan(179 * DAY_SECONDS);
  expect(lifetime).toBeLessThan(181 * DAY_SECONDS);
  expect(await page.evaluate(() => document.cookie)).not.toContain("qs_player");
  expect(await meStatus(page)).toBe(200);

  // Logout ends the family and removes the cookie.
  expect((await postFromPage(page, "/v1/auth/logout")).status).toBe(204);
  expect(await playerCookie(context)).toBeUndefined();
  expect(await meStatus(page)).toBe(401);

  // A returning player signs in at verify: the body holds no token, the cookie does.
  const again = await signInByEmail(page, email, first.code);
  expect(again.answer.raw).not.toMatch(/accessToken|refreshToken/u);
  expect(again.answer.body).toMatchObject({ signedIn: true });
  const old = await playerCookie(context);
  expect(old).toBeDefined();
  expect(await meStatus(page)).toBe(200);

  // A write from another origin is refused, and nothing changes.
  const foreign = await page.request.post("/v1/auth/logout", {
    headers: { origin: "https://evil.example" },
    data: {},
  });
  expect(foreign.status()).toBe(403);
  expect((await playerCookie(context))?.value).toBe(old?.value);

  // A refresh rotates the cookie.
  const refreshed = await postFromPage(page, "/v1/auth/refresh");
  expect(refreshed.status).toBe(200);
  expect(refreshed.raw).not.toMatch(/accessToken|refreshToken/u);
  const rotated = await playerCookie(context);
  expect(rotated?.value).not.toBe(old?.value);
  expect(await meStatus(page)).toBe(200);

  // The old value again, past the API's 60-second grace, is a reused refresh token: the family ends and the cookie goes.
  const aged = await page.request.post(`http://127.0.0.1:${CONTROL_PORT}/player-refresh-aged`, {
    data: { email },
  });
  expect(aged.status()).toBe(204);
  if (old !== undefined) {
    await context.addCookies([{ ...old }]);
  }
  const reused = await postFromPage(page, "/v1/auth/refresh");
  expect(reused.status).toBe(401);
  expect(reused.body).toMatchObject({ code: "session_expired" });
  expect(await playerCookie(context)).toBeUndefined();
  expect(await meStatus(page)).toBe(401);
});
