import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createAuthKeys } from "#src/auth/keys";
import { optOutToken, optOutUrl, readOptOutToken } from "#src/marketing/opt-out";

const OLD_SECRET = "k".repeat(40);
const NEW_SECRET = "n".repeat(40);
/** Today's key: one secret, the default id 1. */
const keys = createAuthKeys(OLD_SECRET);
const other = createAuthKeys("z".repeat(40));
/** After a rotation: id 2 signs, id 1 (the old secret) is still read. */
const rotated = createAuthKeys(NEW_SECRET, { keyId: 2, previous: { id: 1, secret: OLD_SECRET } });
/** After the previous pair is removed. */
const onlyNew = createAuthKeys(NEW_SECRET, { keyId: 2 });
const PLAYER = "5f3c2a10-9b1e-4d7a-8c55-0a1b2c3d4e5f";
const KEY_ID_BYTE = 17;

const bytesOf = (token: string) => Buffer.from(token, "base64url");
const smsToken = (signer = keys) => optOutToken(signer, { playerId: PLAYER, channel: "sms" });
const withByte = (token: string, at: number, value: number) => {
  const bytes = Buffer.from(bytesOf(token));
  bytes[at] = value;
  return bytes.toString("base64url");
};

describe("the opt-out token", () => {
  it.each(["push", "sms", "email"] as const)("round-trips a player's %s channel", (channel) => {
    const token = optOutToken(keys, { playerId: PLAYER, channel });
    expect(token).toMatch(/^[A-Za-z0-9_-]{46}$/);
    expect(bytesOf(token)).toHaveLength(34);
    expect(bytesOf(token)[KEY_ID_BYTE]).toBe(1);
    expect(readOptOutToken(keys, token)).toEqual({ playerId: PLAYER, channel });
  });

  it.each(["push", "sms", "email"] as const)("names the signing key's id (%s)", (channel) => {
    const token = optOutToken(rotated, { playerId: PLAYER, channel });
    expect(bytesOf(token)[KEY_ID_BYTE]).toBe(2);
    expect(readOptOutToken(rotated, token)).toEqual({ playerId: PLAYER, channel });
    expect(readOptOutToken(onlyNew, token)).toEqual({ playerId: PLAYER, channel });
  });

  it("tags the key id, the player and the channel under the opt-out purpose (a fixed format)", () => {
    const key = createHmac("sha256", OLD_SECRET)
      .update("questify/auth/v1/marketing-opt-out")
      .digest();
    const tag = createHmac("sha256", key).update(`1\n${PLAYER}\nsms`).digest().subarray(0, 16);
    const bytes = bytesOf(smsToken());
    expect(bytes.subarray(18).equals(tag)).toBe(true);
    expect(bytes.subarray(0, 16).toString("hex")).toBe(PLAYER.replaceAll("-", ""));
    expect(bytes[16]).toBe(1);
  });

  it("signs the key id: the same secret under another id gives another tag", () => {
    const relabelled = smsToken(createAuthKeys(OLD_SECRET, { keyId: 3 }));
    expect(bytesOf(relabelled).subarray(18).equals(bytesOf(smsToken()).subarray(18))).toBe(false);
  });

  it("opens a link signed before the rotation while the previous key is held, not once it is gone", () => {
    const before = smsToken(keys);
    expect(readOptOutToken(rotated, before)).toEqual({ playerId: PLAYER, channel: "sms" });
    expect(readOptOutToken(onlyNew, before)).toBeNull();
  });

  it("refuses a token whose id byte is moved to the other key held, or to an id held by none", () => {
    expect(readOptOutToken(rotated, withByte(smsToken(keys), KEY_ID_BYTE, 2))).toBeNull();
    expect(readOptOutToken(rotated, withByte(smsToken(rotated), KEY_ID_BYTE, 1))).toBeNull();
    for (const id of [0, 3, 9, 255]) {
      expect(
        readOptOutToken(rotated, withByte(smsToken(rotated), KEY_ID_BYTE, id)),
        `${id}`,
      ).toBeNull();
    }
  });

  it("refuses a token tagged under the previous secret but labelled with the current id", () => {
    const labelled = smsToken(createAuthKeys(OLD_SECRET, { keyId: 2 }));
    expect(bytesOf(labelled)[KEY_ID_BYTE]).toBe(2);
    expect(readOptOutToken(rotated, labelled)).toBeNull();
  });

  it("refuses the old 33-byte token, which has no key id", () => {
    const good = bytesOf(smsToken());
    const old = Buffer.concat([good.subarray(0, 17), good.subarray(18)]);
    expect(old).toHaveLength(33);
    expect(readOptOutToken(keys, old.toString("base64url"))).toBeNull();
  });

  it("refuses a spelling that decodes to the same bytes but is not the canonical one", () => {
    const token = smsToken();
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const last = alphabet.indexOf(token.at(-1) ?? "");
    const twin = `${token.slice(0, -1)}${alphabet[last ^ 1] ?? ""}`;
    expect(twin).not.toBe(token);
    expect(bytesOf(twin).equals(bytesOf(token))).toBe(true);
    expect(readOptOutToken(keys, twin)).toBeNull();
  });

  it("is the same for the same player and channel, and differs for another channel or player", () => {
    const a = smsToken();
    expect(smsToken()).toBe(a);
    expect(optOutToken(keys, { playerId: PLAYER, channel: "email" })).not.toBe(a);
    expect(
      optOutToken(keys, { playerId: "5f3c2a10-9b1e-4d7a-8c55-0a1b2c3d4e60", channel: "sms" }),
    ).not.toBe(a);
  });

  it("reads an upper-case id as the same player", () => {
    expect(optOutToken(keys, { playerId: PLAYER.toUpperCase(), channel: "sms" })).toBe(smsToken());
  });

  it("refuses an id that is not a UUID", () => {
    expect(() => optOutToken(keys, { playerId: "not-a-uuid", channel: "sms" })).toThrow(/UUID/);
  });

  it("is refused when signed with another key", () => {
    expect(readOptOutToken(keys, smsToken(other))).toBeNull();
  });

  it("is refused when the channel or the player is swapped inside the token", () => {
    const token = smsToken();
    const bytes = bytesOf(token);
    expect(readOptOutToken(keys, withByte(token, 16, 0))).toBeNull();
    expect(readOptOutToken(keys, withByte(token, 0, (bytes[0] ?? 0) ^ 1))).toBeNull();
    expect(readOptOutToken(keys, withByte(token, 33, (bytes[33] ?? 0) ^ 1))).toBeNull();
  });

  it("is refused when malformed: wrong length, a channel that does not exist, padding, noise", () => {
    const good = bytesOf(smsToken());
    for (const token of [
      "",
      "short",
      good.subarray(0, 32).toString("base64url"),
      Buffer.concat([good, Buffer.from([0])]).toString("base64url"),
      withByte(smsToken(), 16, 9),
      `${good.toString("base64url")}=`,
      "!".repeat(46),
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
