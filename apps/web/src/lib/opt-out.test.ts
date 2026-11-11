import { describe, expect, it } from "vitest";
import { channelOfToken, optOutResult } from "#src/lib/opt-out.ts";

/** A token's shape: 16 id bytes, one channel byte, one key id byte, 16 tag bytes (the API checks the signature). */
const tokenWith = (channelByte: number): string =>
  Buffer.concat([Buffer.alloc(16, 7), Buffer.from([channelByte, 1]), Buffer.alloc(16, 9)]).toString(
    "base64url",
  );
/** The 33-byte token from before key ids (44 characters), which no server reads any more. */
const oldToken = (channelByte: number): string =>
  Buffer.concat([Buffer.alloc(16, 7), Buffer.from([channelByte]), Buffer.alloc(16, 9)]).toString(
    "base64url",
  );

describe("channelOfToken", () => {
  it.each([
    [0, "push"],
    [1, "sms"],
    [2, "email"],
  ])("reads channel byte %i as %s", (byte, channel) => {
    expect(tokenWith(byte)).toHaveLength(46);
    expect(channelOfToken(tokenWith(byte))).toBe(channel);
  });

  it("is null for the old 44-character token", () => {
    expect(oldToken(1)).toHaveLength(44);
    expect(channelOfToken(oldToken(1))).toBeNull();
  });

  it("is null for a channel byte that names none, a wrong length, noise and nothing", () => {
    expect(channelOfToken(tokenWith(3))).toBeNull();
    expect(channelOfToken(tokenWith(255))).toBeNull();
    expect(channelOfToken(tokenWith(0).slice(1))).toBeNull();
    expect(channelOfToken(`${tokenWith(0)}A`)).toBeNull();
    expect(channelOfToken("nonsense")).toBeNull();
    expect(channelOfToken("!".repeat(46))).toBeNull();
    expect(channelOfToken("")).toBeNull();
    expect(channelOfToken(undefined)).toBeNull();
  });
});

describe("optOutResult", () => {
  it("is done for an answer that went through, whatever the body", () => {
    expect(optOutResult({ ok: true, body: undefined, status: 204 })).toBe("done");
  });

  it("separates a link the API refused from a busy server and a dropped connection", () => {
    expect(optOutResult({ ok: false, body: { code: "invalid_opt_out" }, status: 400 })).toBe(
      "invalid",
    );
    expect(optOutResult({ ok: false, body: { code: "too_many_attempts" }, status: 429 })).toBe(
      "too_many",
    );
    expect(optOutResult({ ok: false, body: undefined, status: 0 })).toBe("network");
    expect(optOutResult({ ok: false, body: undefined, status: 502 })).toBe("network");
    expect(optOutResult({ ok: false, body: { code: "invalid_request" }, status: 400 })).toBe(
      "network",
    );
  });
});
