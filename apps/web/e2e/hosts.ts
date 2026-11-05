import { expect, type Page } from "@playwright/test";
import { BUILDER_PASSWORD, builderEmailOf } from "#e2e/builder.ts";
import { codeFor } from "#e2e/mail.ts";
import { CONSOLE_ORIGIN, CONTROL_PORT, WEB_ORIGIN } from "#e2e/paths.ts";

/**
 * Signs in on the console's own host (T-810d): only there does a platform admin get a console session. The public
 * host's session of the same browser stays as it was, so the person holds one session per host (Q-692).
 */
export async function signInOnConsole(page: Page, email: string, password: string): Promise<void> {
  await page.goto(`${CONSOLE_ORIGIN}/en/sign-in`);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  const previous = await codeFor(email).catch(() => undefined);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("textbox", { name: "Sign-in code" }).fill(await codeFor(email, previous));
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(`${CONSOLE_ORIGIN}/en/console`);
}

/** Makes the owner `openBuilder` signed up a platform admin, then signs them in on the console host. */
export async function makeAdmin(page: Page, eventId: string): Promise<void> {
  const made = await page.request.post(`http://127.0.0.1:${CONTROL_PORT}/make-admin`, {
    data: { eventId },
  });
  expect(made.status()).toBe(204);
  await signInOnConsole(page, builderEmailOf(page), BUILDER_PASSWORD);
}

export type ConsoleAnswer = Readonly<{ status: () => number; json: () => Promise<unknown> }>;

/**
 * One console API call made by a console-host page in the same browser, so the browser itself sends the console
 * session cookie, the Origin and `Sec-Fetch-Site: same-origin` (only the console host forwards `/v1/admin/*`). A page
 * of its own, so the test's page stays where it is; and in the browser, which resolves `console.localhost` everywhere.
 */
export async function consoleRequest(
  page: Page,
  method: "GET" | "PUT" | "POST" | "DELETE",
  path: string,
  data?: unknown,
): Promise<ConsoleAnswer> {
  const helper = await page.context().newPage();
  try {
    await helper.goto(`${CONSOLE_ORIGIN}/en/sign-in`);
    const answer = await helper.evaluate(
      async (call) => {
        const response = await fetch(call.path, {
          method: call.method,
          headers: {
            "content-type": "application/json",
            "idempotency-key": crypto.randomUUID(),
          },
          ...(call.data === undefined ? {} : { body: JSON.stringify(call.data) }),
        });
        return { status: response.status, text: await response.text() };
      },
      { method, path, data },
    );
    return {
      status: () => answer.status,
      json: async () => JSON.parse(answer.text) as unknown,
    };
  } finally {
    await helper.close();
  }
}

/**
 * Follows a link from the console host to a dashboard page on the public host. Chromium counts `console.localhost` and
 * `localhost` as two sites, so the hop arrives without the `SameSite=Strict` session cookie (on staging and production
 * the two hosts are one site and it arrives with it); the page is then opened again, as a same-site hop would.
 */
export async function followToDashboard(page: Page, path: string): Promise<void> {
  await expect(page).toHaveURL(new RegExp(`^${WEB_ORIGIN}/`));
  await page.goto(`${WEB_ORIGIN}${path}`);
  await expect(page).toHaveURL(`${WEB_ORIGIN}${path}`);
}
