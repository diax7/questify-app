import { readFileSync } from "node:fs";
import { expect, type Page, type TestInfo } from "@playwright/test";
import { CODES_FILE } from "#e2e/paths.ts";

/** The seeded password of every e2e account (apps/api/test/e2e-server.ts). */
export const PASSWORD = "correct horse battery staple";
/** A password the e2e API's breach list knows. */
export const BREACHED_PASSWORD = "this one was in a breach 2019";

let addressCounter = 0;
/** Each worker (a spec file in one browser size) picks its own block, so their addresses never meet. */
const ADDRESS_BLOCK = 100 + Math.floor(Math.random() * 150);

/** Each test gets its own client address, so the API's per-address throttles never cross tests. */
export async function freshAddress(page: Page): Promise<void> {
  addressCounter += 1;
  await page.setExtraHTTPHeaders({
    "x-forwarded-for": `198.51.${ADDRESS_BLOCK}.${addressCounter}`,
  });
}

/** The account for this test and browser size (created by apps/api/test/e2e-server.ts). */
export const account = (name: string, info: TestInfo): string =>
  `${name}.${info.project.name}@najd.test`;

type Mailbox = Readonly<{ codes: Record<string, string>; links: Record<string, string> }>;

function readMailbox(): Mailbox {
  try {
    return JSON.parse(readFileSync(CODES_FILE, "utf8")) as Mailbox;
  } catch {
    return { codes: {}, links: {} };
  }
}

/**
 * The code emailed to this address, waiting for the API to send it (it answers before the email goes out). With
 * `previous`, waits for a newer code than that one, for a second sign-in of the same account.
 */
export async function codeFor(email: string, previous?: string): Promise<string> {
  const fresh = (): string | undefined => {
    const code = readMailbox().codes[email];
    return code === previous ? undefined : code;
  };
  await expect.poll(fresh, { timeout: 10_000 }).toMatch(/^[0-9]{6}$/);
  return fresh() ?? "";
}

/** The newest reset or invite link emailed to this address that differs from `previous`. */
export async function linkFor(email: string, previous?: string): Promise<string> {
  const fresh = (): string | undefined => {
    const link = readMailbox().links[email];
    return link === previous ? undefined : link;
  };
  await expect.poll(fresh, { timeout: 10_000 }).toMatch(/\/(?:reset-password|invite)#token=/);
  return fresh() ?? "";
}

/** Signs in through the two steps and waits for the home page. */
export async function signIn(page: Page, email: string, password = PASSWORD): Promise<void> {
  const previous = readMailbox().codes[email];
  await page.goto("/en/sign-in");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("textbox", { name: "Sign-in code" }).fill(await codeFor(email, previous));
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/en$/);
}
