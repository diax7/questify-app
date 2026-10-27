import { createHmac } from "node:crypto";
import { expect, test } from "@playwright/test";
import { freshAddress } from "#e2e/mail.ts";

/** The e2e API's secret (apps/api/test/support/auth-app.ts testConfig) and the purpose the opt-out tag is keyed for. */
const SECRET = "t".repeat(40);
const CHANNELS = ["push", "sms", "email"] as const;

/** A signed link token for a player who does not exist, built the way apps/api/src/marketing/opt-out.ts builds one. */
function tokenFor(playerId: string, channel: (typeof CHANNELS)[number]): string {
  const key = createHmac("sha256", SECRET).update("questify/auth/v1/marketing-opt-out").digest();
  const tag = createHmac("sha256", key).update(`${playerId}\n${channel}`).digest().subarray(0, 16);
  return Buffer.concat([
    Buffer.from(playerId.replaceAll("-", ""), "hex"),
    Buffer.from([CHANNELS.indexOf(channel)]),
    tag,
  ]).toString("base64url");
}

const PLAYER = "5f3c2a10-9b1e-4d7a-8c55-0a1b2c3d4e5f";

test("a signed opt-out link asks first, then turns the channel off, in English", async ({
  page,
}) => {
  await freshAddress(page);
  await page.goto(`/en/opt-out?t=${tokenFor(PLAYER, "sms")}`);
  await expect(
    page.getByRole("heading", { name: "Stop promotional messages", level: 1 }),
  ).toBeVisible();
  await expect(
    page.getByText("Stop Questify's promotional messages by text messages?"),
  ).toBeVisible();
  await page.getByRole("button", { name: "Turn off" }).click();
  await expect(page.getByRole("status")).toContainText(
    "You won't get Questify's promotional messages by text messages",
  );
  await expect(page.getByRole("button", { name: "Turn off" })).toHaveCount(0);
});

test("the opt-out page reads right to left in Arabic and keeps the link when the language changes", async ({
  page,
}) => {
  await freshAddress(page);
  const token = tokenFor(PLAYER, "email");
  await page.goto(`/ar/opt-out?t=${token}`);
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(
    page.getByRole("heading", { name: "إيقاف الرسائل الترويجية", level: 1 }),
  ).toBeVisible();
  await expect(page.getByText("عبر البريد الإلكتروني")).toBeVisible();
  await expect(page.getByRole("link", { name: "English" })).toHaveAttribute(
    "href",
    `/en/opt-out?t=${token}`,
  );
  await page.getByRole("button", { name: "إيقاف", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("تم الإيقاف");
});

test("a forged link is refused by the server and an unreadable one never shows the button", async ({
  page,
}) => {
  await freshAddress(page);
  const forged = Buffer.from(tokenFor(PLAYER, "push"), "base64url");
  forged[forged.length - 1] = (forged[forged.length - 1] ?? 0) ^ 1;
  await page.goto(`/en/opt-out?t=${forged.toString("base64url")}`);
  await page.getByRole("button", { name: "Turn off" }).click();
  await expect(page.getByText("This link isn't valid")).toBeVisible();
  await expect(page.getByRole("button", { name: "Turn off" })).toHaveCount(0);

  for (const url of ["/en/opt-out", "/en/opt-out?t=nonsense"]) {
    await page.goto(url);
    await expect(page.getByText("This link isn't valid")).toBeVisible();
    await expect(page.getByRole("button", { name: "Turn off" })).toHaveCount(0);
  }
});
