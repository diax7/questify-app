import { describe, expect, it } from "vitest";
import type { Client } from "pg";
import { withPreIdentityContext } from "#src/db/pre-identity";

type Call = { text: string; values: unknown[] | undefined };

function fakeClient(): { client: Client; calls: Call[] } {
  const calls: Call[] = [];
  const client = {
    query: async (text: string, values?: unknown[]) => {
      calls.push({ text, values });
      return { rows: [] };
    },
  } as unknown as Client;
  return { client, calls };
}

const HASH = "ab".repeat(32);
const USER = "11111111-2222-4333-8444-555555555555";

const settingsSet = (calls: Call[]): Map<string, unknown> =>
  new Map(
    calls
      .filter((call) => call.text.startsWith("SELECT set_config"))
      .map((call) => [String(call.values?.[0]), call.values?.[1]]),
  );

describe("withPreIdentityContext", () => {
  it("opens one lookup and clears every other setting", async () => {
    const { client, calls } = fakeClient();
    await withPreIdentityContext(client, { kind: "email", email: "a@x.sa" }, async () => 1);
    const settings = settingsSet(calls);
    expect(settings.get("app.auth_email")).toBe("a@x.sa");
    for (const name of [
      "app.organizer_id",
      "app.player_id",
      "app.staff_user_id",
      "app.is_admin",
      "app.session_token_hash",
      "app.challenge_token_hash",
    ]) {
      expect(settings.get(name)).toBe("");
    }
    expect(calls.at(0)?.text).toBe("BEGIN");
    expect(calls.at(-1)?.text).toBe("COMMIT");
  });

  it.each([
    ["session", "app.session_token_hash"],
    ["challenge", "app.challenge_token_hash"],
  ] as const)("opens a %s lookup by token hash", async (kind, setting) => {
    const { client, calls } = fakeClient();
    await withPreIdentityContext(client, { kind, tokenHash: HASH }, async () => 1);
    expect(settingsSet(calls).get(setting)).toBe(HASH);
  });

  it.each([
    ["an upper-case email", { kind: "email", email: "A@x.sa" }],
    ["an email with a space", { kind: "email", email: "a b@x.sa" }],
    ["text without an @", { kind: "email", email: "nobody" }],
    ["an email over 254 characters", { kind: "email", email: `${"a".repeat(250)}@x.sa` }],
    ["a short session hash", { kind: "session", tokenHash: "ab" }],
    ["an upper-case session hash", { kind: "session", tokenHash: "AB".repeat(32) }],
    ["a non-hex challenge hash", { kind: "challenge", tokenHash: "zz".repeat(32) }],
  ] as const)("refuses %s before talking to the database", async (_label, lookup) => {
    const { client, calls } = fakeClient();
    await expect(withPreIdentityContext(client, lookup, async () => 1)).rejects.toThrow(RangeError);
    expect(calls).toEqual([]);
  });

  it("promotes to a user taken from a row and refuses a malformed id", async () => {
    const { client, calls } = fakeClient();
    await withPreIdentityContext(
      client,
      { kind: "email", email: "a@x.sa" },
      async ({ promote }) => {
        await promote(USER);
        await expect(promote("1' OR '1'='1")).rejects.toThrow(RangeError);
      },
    );
    expect(settingsSet(calls).get("app.staff_user_id")).toBe(USER);
  });

  it("opens a created challenge only with a valid hash", async () => {
    const { client, calls } = fakeClient();
    await withPreIdentityContext(
      client,
      { kind: "email", email: "a@x.sa" },
      async ({ openChallenge }) => {
        await openChallenge(HASH);
        await expect(openChallenge("nope")).rejects.toThrow(RangeError);
      },
    );
    expect(settingsSet(calls).get("app.challenge_token_hash")).toBe(HASH);
  });

  it("rolls back and rethrows when the work throws", async () => {
    const { client, calls } = fakeClient();
    await expect(
      withPreIdentityContext(client, { kind: "email", email: "a@x.sa" }, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(calls.at(-1)?.text).toBe("ROLLBACK");
  });
});
