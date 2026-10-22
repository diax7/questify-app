import { randomInt, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createInviteCodeKey,
  createMyCodeKey,
  createQuestCodeKey,
  inviteCode,
  inviteCodeUrl,
  myCode,
  questCode,
  questCodeUrl,
  verifyInviteCode,
  verifyMyCode,
  verifyQuestCode,
} from "#src/quests/qr";

const KEY = createQuestCodeKey("q".repeat(32));
const OTHER_KEY = createQuestCodeKey("r".repeat(32));
const QUEST = "0f9a1c2e-3b4d-4e5f-8a6b-7c8d9e0f1a2b";

/** The token with one character replaced. */
const swapped = (token: string, at: number, by: string) =>
  `${token.slice(0, at)}${by}${token.slice(at + 1)}`;

describe("the quest code key", () => {
  it("refuses a secret under 32 characters", () => {
    expect(() => createQuestCodeKey("q".repeat(31))).toThrow(/QR_SECRET must be at least 32/);
    expect(() => createQuestCodeKey("q".repeat(32))).not.toThrow();
  });

  it("differs from a key made for any other purpose of the same secret", () => {
    expect(questCode(KEY, QUEST, 1)).not.toBe(questCode(OTHER_KEY, QUEST, 1));
  });
});

describe("questCode", () => {
  it("is 50 URL-safe characters and the same each time for the same quest and version", () => {
    const token = questCode(KEY, QUEST, 1);
    expect(token).toMatch(/^[A-Za-z0-9_-]{50}$/);
    expect(questCode(KEY, QUEST, 1)).toBe(token);
    expect(questCode(KEY, QUEST, 2)).not.toBe(token);
  });

  it("puts the token on the dashboard's /q/ page", () => {
    expect(questCodeUrl("https://questify.nafes.com", "abc")).toBe(
      "https://questify.nafes.com/q/abc",
    );
  });

  it.each([0, -1, 1.5, 2 ** 32])("refuses version %s", (version) => {
    expect(() => questCode(KEY, QUEST, version)).toThrow(/Not a code version/);
  });

  it("refuses an id that is not a quest id", () => {
    expect(() => questCode(KEY, "not-a-uuid", 1)).toThrow(/Not an id/);
  });

  it("accepts the highest version", () => {
    const token = questCode(KEY, QUEST, 0xffff_ffff);
    expect(verifyQuestCode(KEY, token, QUEST)).toEqual({
      kind: "valid",
      questId: QUEST,
      version: 0xffff_ffff,
    });
  });
});

describe("verifyQuestCode", () => {
  const token = questCode(KEY, QUEST, 7);

  it("reads back the quest and version of a real code", () => {
    expect(verifyQuestCode(KEY, token, QUEST)).toEqual({
      kind: "valid",
      questId: QUEST,
      version: 7,
    });
    expect(verifyQuestCode(KEY, token, QUEST.toUpperCase())).toMatchObject({ kind: "valid" });
  });

  it("refuses a real code used on another quest", () => {
    expect(verifyQuestCode(KEY, token, randomUUID())).toEqual({ kind: "wrong_quest" });
  });

  it("refuses a code signed with another key", () => {
    expect(verifyQuestCode(OTHER_KEY, token, QUEST)).toEqual({ kind: "forged" });
  });

  it("refuses a code with any single byte changed, wherever it is", () => {
    const bytes = Buffer.from(token, "base64url");
    for (let at = 1; at < bytes.length; at += 1) {
      const changed = Buffer.from(bytes);
      changed[at] = (changed[at] ?? 0) ^ 0x01;
      const result = verifyQuestCode(KEY, changed.toString("base64url"), QUEST);
      expect(result.kind, `byte ${at}`).toBe("forged");
    }
  });

  it("refuses a code of another layout", () => {
    const bytes = Buffer.from(token, "base64url");
    bytes[0] = 0x02;
    expect(verifyQuestCode(KEY, bytes.toString("base64url"), QUEST)).toEqual({
      kind: "not_questify",
    });
  });

  it.each([
    ["empty", ""],
    ["one short", token.slice(0, 49)],
    ["one long", `${token}A`],
    ["padded", `${token}==`],
    ["with a space", ` ${token.slice(1)}`],
    ["with a newline", `${token.slice(0, 49)}\n`],
    ["in the other base64 alphabet", swapped(token, 10, "+")],
    ["with a slash", swapped(token, 10, "/")],
    ["with an Arabic letter", swapped(token, 10, "ب")],
    ["a whole URL", questCodeUrl("https://questify.nafes.com", token)],
  ])("refuses a token %s as not Questify's", (_name, value) => {
    expect(verifyQuestCode(KEY, value, QUEST)).toEqual({ kind: "not_questify" });
  });

  it("refuses the other spellings of the same bytes (only the canonical one counts)", () => {
    const last = token.at(-1) ?? "A";
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const sameBytes = [...alphabet].filter(
      (char) =>
        char !== last &&
        Buffer.from(swapped(token, 49, char), "base64url").equals(Buffer.from(token, "base64url")),
    );
    expect(sameBytes.length).toBeGreaterThan(0);
    for (const char of sameBytes) {
      expect(verifyQuestCode(KEY, swapped(token, 49, char), QUEST)).toEqual({
        kind: "not_questify",
      });
    }
  });

  it("round-trips 1,000 random quests and versions", () => {
    for (let n = 0; n < 1000; n += 1) {
      const quest = randomUUID();
      const version = randomInt(1, 2 ** 31);
      expect(verifyQuestCode(KEY, questCode(KEY, quest, version), quest)).toEqual({
        kind: "valid",
        questId: quest,
        version,
      });
    }
  });
});

describe("My QR and operator invite codes", () => {
  const SECRET = "q".repeat(32);
  const MY = createMyCodeKey(SECRET);
  const INVITE = createInviteCodeKey(SECRET);
  const PLAYER = "5b1f0c2e-3b4d-4e5f-8a6b-7c8d9e0f1a2b";

  it("refuses a short secret for every purpose", () => {
    expect(() => createMyCodeKey("q".repeat(31))).toThrow(/QR_SECRET must be at least 32/);
    expect(() => createInviteCodeKey("q".repeat(31))).toThrow(/QR_SECRET must be at least 32/);
  });

  it("opens a My QR to its player and version, and nothing else", () => {
    const token = myCode(MY, PLAYER, 7);
    expect(token).toMatch(/^[A-Za-z0-9_-]{50}$/);
    expect(verifyMyCode(MY, token)).toEqual({ kind: "valid", playerId: PLAYER, version: 7 });
    expect(verifyMyCode(createMyCodeKey("r".repeat(32)), token)).toEqual({ kind: "forged" });
    expect(verifyMyCode(MY, swapped(token, 49, token[49] === "A" ? "B" : "A"))).toMatchObject({
      kind: expect.stringMatching(/forged|not_questify/),
    });
    expect(verifyMyCode(MY, "hello")).toEqual({ kind: "not_questify" });
  });

  it("never opens a code of one purpose as another, even under the same secret", () => {
    const quest = questCode(createQuestCodeKey(SECRET), PLAYER, 1);
    const my = myCode(MY, PLAYER, 1);
    const invite = inviteCode(INVITE, PLAYER);
    expect(verifyMyCode(MY, quest)).toEqual({ kind: "not_questify" });
    expect(verifyMyCode(MY, invite)).toEqual({ kind: "not_questify" });
    expect(verifyInviteCode(INVITE, my)).toEqual({ kind: "not_questify" });
    expect(verifyQuestCode(createQuestCodeKey(SECRET), my, PLAYER)).toEqual({
      kind: "not_questify",
    });
    expect(new Set([quest, my, invite]).size).toBe(3);
  });

  it("opens an invite to its id and puts the token in the address's fragment", () => {
    const id = randomUUID();
    const token = inviteCode(INVITE, id);
    expect(verifyInviteCode(INVITE, token)).toEqual({ kind: "valid", inviteId: id });
    expect(verifyInviteCode(createInviteCodeKey("r".repeat(32)), token)).toEqual({
      kind: "forged",
    });
    expect(inviteCodeUrl("https://questify.nafes.com", "en", token)).toBe(
      `https://questify.nafes.com/en/op#${token}`,
    );
  });
});
