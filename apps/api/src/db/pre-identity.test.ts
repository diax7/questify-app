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
const emailOfLength = (length: number): string => `${"a".repeat(length - 5)}@x.sa`;
const USER = "11111111-2222-4333-8444-555555555555";

const settingsSet = (calls: Call[]): Map<string, unknown> => {
  const settings = new Map<string, unknown>();
  for (const call of calls.filter((entry) => entry.text.includes("set_config"))) {
    const [names, values] = call.values as [string[], string[]];
    names.forEach((name, index) => settings.set(name, values[index]));
  }
  return settings;
};

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
    [
      "an email with a NUL character",
      { kind: "email", email: `a${String.fromCodePoint(0)}b@x.sa` },
    ],
    [
      "an email with a control character",
      { kind: "email", email: `a${String.fromCodePoint(31)}b@x.sa` },
    ],
    ["an email over 254 characters", { kind: "email", email: `${"a".repeat(250)}@x.sa` }],
    ["a short session hash", { kind: "session", tokenHash: "ab" }],
    ["an upper-case session hash", { kind: "session", tokenHash: "AB".repeat(32) }],
    ["a non-hex challenge hash", { kind: "challenge", tokenHash: "zz".repeat(32) }],
  ] as const)("refuses %s before talking to the database", async (_label, lookup) => {
    const { client, calls } = fakeClient();
    await expect(withPreIdentityContext(client, lookup, async () => 1)).rejects.toThrow(RangeError);
    expect(calls).toEqual([]);
  });

  it("names what is wrong with a refused lookup", async () => {
    const { client } = fakeClient();
    const run = (lookup: Parameters<typeof withPreIdentityContext>[1]) =>
      withPreIdentityContext(client, lookup, async () => 1);
    await expect(run({ kind: "email", email: "A@x.sa" })).rejects.toThrow(
      /normalized \(lowercase\)/,
    );
    await expect(run({ kind: "session", tokenHash: "ab" })).rejects.toThrow(/tokenHash must be 64/);
    await expect(run({ kind: "challenge", tokenHash: "ab" })).rejects.toThrow(
      /tokenHash must be 64/,
    );
  });

  it("allows an email of exactly 254 characters and refuses 255", async () => {
    const { client } = fakeClient();
    await expect(
      withPreIdentityContext(client, { kind: "email", email: emailOfLength(254) }, async () => 1),
    ).resolves.toBe(1);
    await expect(
      withPreIdentityContext(client, { kind: "email", email: emailOfLength(255) }, async () => 1),
    ).rejects.toThrow(RangeError);
  });

  it("refuses the DEL character and text after the address", async () => {
    const { client, calls } = fakeClient();
    for (const email of [`a${String.fromCodePoint(0x7f)}b@x.sa`, "a@x.sa y", "a@x.sa\n"]) {
      await expect(
        withPreIdentityContext(client, { kind: "email", email }, async () => 1),
      ).rejects.toThrow(RangeError);
    }
    expect(calls).toEqual([]);
  });

  it("refuses ids and hashes with anything before or after them", async () => {
    const { client } = fakeClient();
    const hash = "ab".repeat(32);
    for (const tokenHash of [`zz${hash}`, `${hash}zz`]) {
      await expect(
        withPreIdentityContext(client, { kind: "session", tokenHash }, async () => 1),
      ).rejects.toThrow(RangeError);
    }
    await withPreIdentityContext(
      client,
      { kind: "email", email: "a@x.sa" },
      async ({ promote }) => {
        await expect(promote(`x${USER}`)).rejects.toThrow(/must be a UUID/);
        await expect(promote(`${USER}x`)).rejects.toThrow(/must be a UUID/);
      },
    );
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
