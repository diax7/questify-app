import { expect, type Page } from "@playwright/test";
import { codeFor } from "#e2e/mail.ts";

/** The terms and privacy versions the e2e database starts with (as the API tests accept them). */
const ACCEPT = { terms: "0.1", privacy: "0.1" };

export type Answer = Readonly<{ status: number; body: unknown; raw: string }>;

/** One JSON POST from the page itself, so the browser sends its own Origin and the cookie jar applies. */
export async function postFromPage(page: Page, path: string, body: unknown = {}): Promise<Answer> {
  return page.evaluate(
    async ({ path: target, body: payload }) => {
      const response = await fetch(target, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const raw = await response.text();
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = null;
      }
      return { status: response.status, body: parsed, raw };
    },
    { path, body },
  );
}

/** `GET /v1/me` from the page: its status only. */
export const meStatus = (page: Page): Promise<number> =>
  page.evaluate(async () => (await fetch("/v1/me", { credentials: "same-origin" })).status);

/** Asks for an email code from the page and answers the challenge and the code it brought. */
async function codeStep(page: Page, email: string, previous?: string) {
  const asked = await postFromPage(page, "/v1/auth/code", {
    channel: "email",
    value: email,
    lang: "en",
    accept: ACCEPT,
  });
  expect(asked.status).toBe(202);
  const { challengeToken } = asked.body as { challengeToken: string };
  return { challengeToken, code: await codeFor(email, previous) };
}

/**
 * A new player signs up by email through the forwarder (verify answers the profile step, signup sets the cookie); a
 * returning one signs in at verify. Answers the step that set the cookie and the code used.
 */
export async function signInByEmail(
  page: Page,
  email: string,
  previous?: string,
): Promise<{ answer: Answer; code: string }> {
  const { challengeToken, code } = await codeStep(page, email, previous);
  const verified = await postFromPage(page, "/v1/auth/verify", { challengeToken, code });
  expect(verified.status).toBe(200);
  const signupToken = (verified.body as { signupToken?: unknown }).signupToken;
  if (typeof signupToken !== "string") {
    return { answer: verified, code };
  }
  const name = `web_${email.split("@")[0]?.replace(/[^a-z0-9]/gu, "") ?? "p"}`.slice(0, 20);
  const signedUp = await postFromPage(page, "/v1/auth/signup", {
    signupToken,
    username: name,
    birthYear: 1995,
    avatar: "fox",
  });
  expect(signedUp.status).toBe(201);
  return { answer: signedUp, code };
}
