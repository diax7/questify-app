import { describe, expect, it } from "vitest";
import { createAuthKeys } from "#src/auth/keys";
import { optOutToken, optOutUrl, readOptOutToken } from "#src/marketing/opt-out";

const keys = createAuthKeys("k".repeat(40));
const other = createAuthKeys("z".repeat(40));
const PLAYER = "5f3c2a10-9b1e-4d7a-8c55-0a1b2c3d4e5f";

describe("the opt-out token", () => {
  it.each(["push", "sms", "email"] as const)("round-trips a player's %s channel", (channel) => {
    const token = optOutToken(keys, { playerId: PLAYER, channel });
    expect(token).toMatch(/^[A-Za-z0-9_-]{44}$/);
    expect(readOptOutToken(keys, token)).toEqual({ playerId: PLAYER, channel });
  });

  it("is the same for the same player and channel, and differs for another channel or player", () => {
    const a = optOutToken(keys, { playerId: PLAYER, channel: "sms" });
    expect(optOutToken(keys, { playerId: PLAYER, channel: "sms" })).toBe(a);
    expect(optOutToken(keys, { playerId: PLAYER, channel: "email" })).not.toBe(a);
    expect(
      optOutToken(keys, { playerId: "5f3c2a10-9b1e-4d7a-8c55-0a1b2c3d4e60", channel: "sms" }),
    ).not.toBe(a);
  });

  it("reads an upper-case id as the same player", () => {
    expect(optOutToken(keys, { playerId: PLAYER.toUpperCase(), channel: "sms" })).toBe(
      optOutToken(keys, { playerId: PLAYER, channel: "sms" }),
    );
  });

  it("refuses an id that is not a UUID", () => {
    expect(() => optOutToken(keys, { playerId: "not-a-uuid", channel: "sms" })).toThrow(/UUID/);
  });

  it("is refused when signed with another key", () => {
    const token = optOutToken(other, { playerId: PLAYER, channel: "sms" });
    expect(readOptOutToken(keys, token)).toBeNull();
  });

  it("is refused when the channel or the player is swapped inside the token", () => {
    const bytes = Buffer.from(optOutToken(keys, { playerId: PLAYER, channel: "sms" }), "base64url");
    const swapped = Buffer.from(bytes);
    swapped[16] = 0;
    expect(readOptOutToken(keys, swapped.toString("base64url"))).toBeNull();
    const moved = Buffer.from(bytes);
    moved[0] = (moved[0] ?? 0) ^ 1;
    expect(readOptOutToken(keys, moved.toString("base64url"))).toBeNull();
    const forged = Buffer.from(bytes);
    forged[forged.length - 1] = (forged[forged.length - 1] ?? 0) ^ 1;
    expect(readOptOutToken(keys, forged.toString("base64url"))).toBeNull();
  });

  it("is refused when malformed: wrong length, a channel that does not exist, padding, noise", () => {
    const good = Buffer.from(optOutToken(keys, { playerId: PLAYER, channel: "sms" }), "base64url");
    const unknownChannel = Buffer.from(good);
    unknownChannel[16] = 9;
    for (const token of [
      "",
      "short",
      good.subarray(0, 32).toString("base64url"),
      Buffer.concat([good, Buffer.from([0])]).toString("base64url"),
      unknownChannel.toString("base64url"),
      `${good.toString("base64url")}=`,
      "!".repeat(44),
    ]) {
      expect(readOptOutToken(keys, token), token).toBeNull();
    }
  });
});

describe("optOutUrl", () => {
  it("points at the opt-out page in the message's language, with the token", () => {
    const url = new URL(optOutUrl(keys, { playerId: PLAYER, channel: "email" }, "ar"));
    expect(url.protocol).toBe("https:");
    expect(url.pathname).toBe("/ar/opt-out");
    expect(readOptOutToken(keys, url.searchParams.get("t") ?? "")).toEqual({
      playerId: PLAYER,
      channel: "email",
    });
  });
});
