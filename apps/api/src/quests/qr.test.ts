import { randomInt, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createInviteCodeKey,
  createLiveCodeKey,
  createMyCodeKey,
  createQuestCodeKey,
  createRevealCodeKey,
  createScreenCodeKey,
  createStepCodeKey,
  createTagCodeKey,
  inviteCode,
  inviteCodeUrl,
  liveCode,
  myCode,
  questCode,
  questCodeUrl,
  revealCode,
  screenCode,
  screenCodeUrl,
  stepCode,
  tagCode,
  tagCodeUrl,
  verifyInviteCode,
  verifyLiveCode,
  verifyMyCode,
  verifyQuestCode,
  verifyRevealCode,
  verifyScreenCode,
  verifyStepCode,
  verifyTagCode,
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

describe("passport step codes (T-304b)", () => {
  const SECRET = "q".repeat(32);
  const STEP_KEY = createStepCodeKey(SECRET);
  const STEP = "7c2d0c2e-3b4d-4e5f-8a6b-7c8d9e0f1a2b";

  it("refuses a short secret", () => {
    expect(() => createStepCodeKey("q".repeat(31))).toThrow(/QR_SECRET must be at least 32/);
  });

  it("opens a step code to its step and version, upper or lower case in the path", () => {
    const token = stepCode(STEP_KEY, STEP, 3);
    expect(token).toMatch(/^[A-Za-z0-9_-]{50}$/);
    expect(verifyStepCode(STEP_KEY, token, STEP)).toEqual({
      kind: "valid",
      stepId: STEP,
      version: 3,
    });
    expect(verifyStepCode(STEP_KEY, token, STEP.toUpperCase())).toMatchObject({ kind: "valid" });
    expect(verifyStepCode(createStepCodeKey("r".repeat(32)), token, STEP)).toEqual({
      kind: "forged",
    });
    expect(verifyStepCode(STEP_KEY, "hello", STEP)).toEqual({ kind: "not_questify" });
  });

  it("refuses a real code of another step", () => {
    const token = stepCode(STEP_KEY, randomUUID(), 1);
    expect(verifyStepCode(STEP_KEY, token, STEP)).toEqual({ kind: "wrong_step" });
  });

  it("never opens as a quest, My QR or invite code, nor they as a step code", () => {
    const step = stepCode(STEP_KEY, STEP, 1);
    const quest = questCode(createQuestCodeKey(SECRET), STEP, 1);
    const my = myCode(createMyCodeKey(SECRET), STEP, 1);
    expect(verifyQuestCode(createQuestCodeKey(SECRET), step, STEP)).toEqual({
      kind: "not_questify",
    });
    expect(verifyMyCode(createMyCodeKey(SECRET), step)).toEqual({ kind: "not_questify" });
    expect(verifyInviteCode(createInviteCodeKey(SECRET), step)).toEqual({ kind: "not_questify" });
    expect(verifyStepCode(STEP_KEY, quest, STEP)).toEqual({ kind: "not_questify" });
    expect(verifyStepCode(STEP_KEY, my, STEP)).toEqual({ kind: "not_questify" });
  });
});

describe("hidden category codes (T-304c)", () => {
  const SECRET = "q".repeat(32);
  const REVEAL_KEY = createRevealCodeKey(SECRET);
  const CATEGORY = "5e1b0c2e-3b4d-4e5f-8a6b-7c8d9e0f1a2b";

  it("refuses a short secret", () => {
    expect(() => createRevealCodeKey("q".repeat(31))).toThrow(/QR_SECRET must be at least 32/);
  });

  it("opens a secret code to its category and version, upper or lower case in the path", () => {
    const token = revealCode(REVEAL_KEY, CATEGORY, 4);
    expect(token).toMatch(/^[A-Za-z0-9_-]{50}$/);
    expect(Buffer.from(token, "base64url")[0]).toBe(0x05);
    expect(verifyRevealCode(REVEAL_KEY, token, CATEGORY)).toEqual({
      kind: "valid",
      categoryId: CATEGORY,
      version: 4,
    });
    expect(verifyRevealCode(REVEAL_KEY, token, CATEGORY.toUpperCase())).toMatchObject({
      kind: "valid",
    });
    expect(verifyRevealCode(createRevealCodeKey("r".repeat(32)), token, CATEGORY)).toEqual({
      kind: "forged",
    });
    expect(verifyRevealCode(REVEAL_KEY, "hello", CATEGORY)).toEqual({ kind: "not_questify" });
  });

  it("refuses a real code of another category", () => {
    const token = revealCode(REVEAL_KEY, randomUUID(), 1);
    expect(verifyRevealCode(REVEAL_KEY, token, CATEGORY)).toEqual({ kind: "wrong_category" });
  });

  it("never opens as any other code, nor they as a secret code", () => {
    const secret = revealCode(REVEAL_KEY, CATEGORY, 1);
    const quest = questCode(createQuestCodeKey(SECRET), CATEGORY, 1);
    const step = stepCode(createStepCodeKey(SECRET), CATEGORY, 1);
    expect(verifyQuestCode(createQuestCodeKey(SECRET), secret, CATEGORY)).toEqual({
      kind: "not_questify",
    });
    expect(verifyStepCode(createStepCodeKey(SECRET), secret, CATEGORY)).toEqual({
      kind: "not_questify",
    });
    expect(verifyMyCode(createMyCodeKey(SECRET), secret)).toEqual({ kind: "not_questify" });
    expect(verifyInviteCode(createInviteCodeKey(SECRET), secret)).toEqual({
      kind: "not_questify",
    });
    expect(verifyRevealCode(REVEAL_KEY, quest, CATEGORY)).toEqual({ kind: "not_questify" });
    expect(verifyRevealCode(REVEAL_KEY, step, CATEGORY)).toEqual({ kind: "not_questify" });
  });
});

describe("NFC tag codes (T-308)", () => {
  const SECRET = "q".repeat(32);
  const TAG_KEY = createTagCodeKey(SECRET);
  const TAG = "7c2d0c2e-3b4d-4e5f-8a6b-7c8d9e0f1a2b";

  it("refuses a short secret", () => {
    expect(() => createTagCodeKey("q".repeat(31))).toThrow(/QR_SECRET must be at least 32/);
  });

  it("opens a tag's token to its id and version, 50 characters of format 0x06", () => {
    const token = tagCode(TAG_KEY, TAG, 3);
    expect(token).toMatch(/^[A-Za-z0-9_-]{50}$/);
    expect(Buffer.from(token, "base64url")[0]).toBe(0x06);
    expect(verifyTagCode(TAG_KEY, token)).toEqual({ kind: "valid", tagId: TAG, version: 3 });
    expect(verifyTagCode(createTagCodeKey("r".repeat(32)), token)).toEqual({ kind: "forged" });
    expect(verifyTagCode(TAG_KEY, swapped(token, 30, token[30] === "A" ? "B" : "A"))).toEqual({
      kind: "forged",
    });
    expect(verifyTagCode(TAG_KEY, "hello")).toEqual({ kind: "not_questify" });
    expect(tagCodeUrl("https://questify.nafes.com", token)).toBe(
      `https://questify.nafes.com/t/${token}`,
    );
  });

  it("accepts only the canonical encoding", () => {
    const token = tagCode(TAG_KEY, TAG, 1);
    const last = token.at(-1) ?? "A";
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const sibling = alphabet[(alphabet.indexOf(last) ^ 1) % 64] ?? "A";
    expect(verifyTagCode(TAG_KEY, `${token.slice(0, -1)}${sibling}`)).toEqual({
      kind: "not_questify",
    });
  });

  it("never opens as any other code, nor they as a tag", () => {
    const tag = tagCode(TAG_KEY, TAG, 1);
    expect(verifyQuestCode(createQuestCodeKey(SECRET), tag, TAG)).toEqual({ kind: "not_questify" });
    expect(verifyStepCode(createStepCodeKey(SECRET), tag, TAG)).toEqual({ kind: "not_questify" });
    expect(verifyRevealCode(createRevealCodeKey(SECRET), tag, TAG)).toEqual({
      kind: "not_questify",
    });
    expect(verifyMyCode(createMyCodeKey(SECRET), tag)).toEqual({ kind: "not_questify" });
    expect(verifyInviteCode(createInviteCodeKey(SECRET), tag)).toEqual({ kind: "not_questify" });
    for (const other of [
      questCode(createQuestCodeKey(SECRET), TAG, 1),
      myCode(createMyCodeKey(SECRET), TAG, 1),
      inviteCode(createInviteCodeKey(SECRET), TAG),
      stepCode(createStepCodeKey(SECRET), TAG, 1),
      revealCode(createRevealCodeKey(SECRET), TAG, 1),
    ]) {
      expect(verifyTagCode(TAG_KEY, other)).toEqual({ kind: "not_questify" });
    }
  });
});

describe("screen codes (T-309)", () => {
  const SECRET = "q".repeat(32);
  const SCREEN_KEY = createScreenCodeKey(SECRET);
  const WINDOW = 59_416_440;

  it("refuses a short secret", () => {
    expect(() => createScreenCodeKey("q".repeat(31))).toThrow(/QR_SECRET must be at least 32/);
  });

  it("opens to its quest and window, 50 characters of format 0x07", () => {
    const token = screenCode(SCREEN_KEY, QUEST, WINDOW);
    expect(token).toMatch(/^[A-Za-z0-9_-]{50}$/);
    expect(Buffer.from(token, "base64url")[0]).toBe(0x07);
    expect(verifyScreenCode(SCREEN_KEY, token, QUEST.toUpperCase())).toEqual({
      kind: "valid",
      questId: QUEST,
      window: WINDOW,
    });
    expect(screenCode(SCREEN_KEY, QUEST, WINDOW + 1)).not.toBe(token);
    expect(screenCodeUrl("https://questify.nafes.com", token)).toBe(
      `https://questify.nafes.com/s/${token}`,
    );
  });

  it("answers wrong_quest for another quest, forged for another key or a changed byte", () => {
    const token = screenCode(SCREEN_KEY, QUEST, WINDOW);
    expect(verifyScreenCode(SCREEN_KEY, token, randomUUID())).toEqual({ kind: "wrong_quest" });
    expect(verifyScreenCode(createScreenCodeKey("r".repeat(32)), token, QUEST)).toEqual({
      kind: "forged",
    });
    expect(
      verifyScreenCode(SCREEN_KEY, swapped(token, 30, token[30] === "A" ? "B" : "A"), QUEST),
    ).toEqual({ kind: "forged" });
    expect(verifyScreenCode(SCREEN_KEY, "hello", QUEST)).toEqual({ kind: "not_questify" });
  });

  it("accepts only the canonical encoding", () => {
    const token = screenCode(SCREEN_KEY, QUEST, WINDOW);
    const last = token.at(-1) ?? "A";
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const sibling = alphabet[(alphabet.indexOf(last) ^ 1) % 64] ?? "A";
    expect(verifyScreenCode(SCREEN_KEY, `${token.slice(0, -1)}${sibling}`, QUEST)).toEqual({
      kind: "not_questify",
    });
  });

  it("never opens as any other code, nor they as a screen code", () => {
    const screen = screenCode(SCREEN_KEY, QUEST, WINDOW);
    expect(verifyQuestCode(createQuestCodeKey(SECRET), screen, QUEST)).toEqual({
      kind: "not_questify",
    });
    expect(verifyTagCode(createTagCodeKey(SECRET), screen)).toEqual({ kind: "not_questify" });
    expect(verifyMyCode(createMyCodeKey(SECRET), screen)).toEqual({ kind: "not_questify" });
    for (const other of [
      questCode(createQuestCodeKey(SECRET), QUEST, WINDOW),
      myCode(createMyCodeKey(SECRET), QUEST, WINDOW),
      inviteCode(createInviteCodeKey(SECRET), QUEST),
      stepCode(createStepCodeKey(SECRET), QUEST, WINDOW),
      revealCode(createRevealCodeKey(SECRET), QUEST, WINDOW),
      tagCode(createTagCodeKey(SECRET), QUEST, WINDOW),
    ]) {
      expect(verifyScreenCode(SCREEN_KEY, other, QUEST)).toEqual({ kind: "not_questify" });
    }
  });
});

describe("live codes (T-309b)", () => {
  const SECRET = "q".repeat(32);
  const LIVE_KEY = createLiveCodeKey(SECRET);
  const PLAYER = "6a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
  const WINDOW = 59_416_440;

  it("refuses a short secret", () => {
    expect(() => createLiveCodeKey("q".repeat(31))).toThrow(/QR_SECRET must be at least 32/);
  });

  it("opens to its player and window, 50 characters of format 0x08, no URL", () => {
    const token = liveCode(LIVE_KEY, PLAYER, WINDOW);
    expect(token).toMatch(/^[A-Za-z0-9_-]{50}$/);
    expect(Buffer.from(token, "base64url")[0]).toBe(0x08);
    expect(verifyLiveCode(LIVE_KEY, token)).toEqual({
      kind: "valid",
      playerId: PLAYER,
      window: WINDOW,
    });
    expect(liveCode(LIVE_KEY, PLAYER, WINDOW + 1)).not.toBe(token);
  });

  it("answers forged for another key or a changed byte, not_questify for junk", () => {
    const token = liveCode(LIVE_KEY, PLAYER, WINDOW);
    expect(verifyLiveCode(createLiveCodeKey("r".repeat(32)), token)).toEqual({ kind: "forged" });
    expect(verifyLiveCode(LIVE_KEY, swapped(token, 30, token[30] === "A" ? "B" : "A"))).toEqual({
      kind: "forged",
    });
    expect(verifyLiveCode(LIVE_KEY, "hello")).toEqual({ kind: "not_questify" });
    expect(verifyLiveCode(LIVE_KEY, `https://questify.nafes.com/s/${token}`)).toEqual({
      kind: "not_questify",
    });
  });

  it("accepts only the canonical encoding", () => {
    const token = liveCode(LIVE_KEY, PLAYER, WINDOW);
    const last = token.at(-1) ?? "A";
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const sibling = alphabet[(alphabet.indexOf(last) ^ 1) % 64] ?? "A";
    expect(verifyLiveCode(LIVE_KEY, `${token.slice(0, -1)}${sibling}`)).toEqual({
      kind: "not_questify",
    });
  });

  it("never opens as any other code (a My QR above all), nor they as a live code", () => {
    const live = liveCode(LIVE_KEY, PLAYER, WINDOW);
    expect(verifyMyCode(createMyCodeKey(SECRET), live)).toEqual({ kind: "not_questify" });
    expect(verifyScreenCode(createScreenCodeKey(SECRET), live, PLAYER)).toEqual({
      kind: "not_questify",
    });
    expect(verifyTagCode(createTagCodeKey(SECRET), live)).toEqual({ kind: "not_questify" });
    for (const other of [
      questCode(createQuestCodeKey(SECRET), PLAYER, WINDOW),
      myCode(createMyCodeKey(SECRET), PLAYER, WINDOW),
      inviteCode(createInviteCodeKey(SECRET), PLAYER),
      stepCode(createStepCodeKey(SECRET), PLAYER, WINDOW),
      revealCode(createRevealCodeKey(SECRET), PLAYER, WINDOW),
      tagCode(createTagCodeKey(SECRET), PLAYER, WINDOW),
      screenCode(createScreenCodeKey(SECRET), PLAYER, WINDOW),
    ]) {
      expect(verifyLiveCode(LIVE_KEY, other)).toEqual({ kind: "not_questify" });
    }
  });
});
