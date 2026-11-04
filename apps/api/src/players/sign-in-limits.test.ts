import { describe, expect, it } from "vitest";
import { createAuthKeys } from "#src/auth/keys";
import { PLAYER_SIGN_IN_LIMITS as L } from "#src/auth/limits";
import { addressBucket } from "#src/auth/normalize";
import { BUCKETS } from "#src/auth/throttle";
import { earnedLimit, failureCounts, sendCounts } from "#src/players/sign-in-limits";

const keys = createAuthKeys("k".repeat(40));
const PHONE = { channel: "phone", value: "+966551234567" } as const;
const EMAIL = { channel: "email", value: "a@example.com" } as const;
const ADDRESS = "203.0.113.9";
const DEVICE = "6f1c2a1e-7d3b-4c5a-9e8f-0a1b2c3d4e5f";

describe("player sign-in windows", () => {
  it("counts every send per contact (an hour and a day), per address and per install", () => {
    const contact = keys.contactThrottleKey(PHONE.value);
    expect(sendCounts(keys, PHONE, ADDRESS, DEVICE)).toEqual([
      { bucket: BUCKETS.playerCodeContact, key: contact, limit: L.codesPerContactHour },
      { bucket: BUCKETS.playerCodeContact, key: contact, limit: L.codesPerContactDay },
      {
        bucket: BUCKETS.playerCodeAddress,
        key: keys.addressKey(addressBucket(ADDRESS)),
        limit: L.codesPerAddressHour,
        earned: {
          bucket: BUCKETS.playerVerifiedPhoneAddress,
          perVerified: 2,
          ceiling: 2000,
        },
      },
      {
        bucket: BUCKETS.playerCodeDevice,
        key: keys.deviceKey(DEVICE),
        limit: L.codesPerDeviceHour,
      },
    ]);
  });

  it("leaves the install out when the app sent none", () => {
    const counts = sendCounts(keys, PHONE, ADDRESS, undefined);
    expect(counts.map((count) => count.bucket)).not.toContain(BUCKETS.playerCodeDevice);
    expect(counts).toHaveLength(3);
  });

  it("counts wrong codes per contact (15 minutes and a day) and per address", () => {
    const contact = keys.contactThrottleKey(PHONE.value);
    expect(failureCounts(keys, PHONE, ADDRESS)).toEqual([
      { bucket: BUCKETS.playerFailContact, key: contact, limit: L.failuresPerContact },
      { bucket: BUCKETS.playerFailContact, key: contact, limit: L.failuresPerContactDay },
      {
        bucket: BUCKETS.playerFailAddress,
        key: keys.addressKey(addressBucket(ADDRESS)),
        limit: L.failuresPerAddress,
        earned: { bucket: BUCKETS.playerVerifiedPhoneAddress, perVerified: 1, ceiling: 500 },
      },
    ]);
  });

  it("holds the numbers the plan and the docs state", () => {
    expect(L).toMatchObject({
      codesPerContactHour: { max: 5, windowSeconds: 3600 },
      codesPerContactDay: { max: 10, windowSeconds: 86_400 },
      codesPerDeviceHour: { max: 10, windowSeconds: 3600 },
      codesPerAddressHour: { max: 200, perVerified: 2, ceiling: 2000, windowSeconds: 3600 },
      failuresPerContact: { max: 10, windowSeconds: 900 },
      failuresPerContactDay: { max: 30, windowSeconds: 86_400 },
      failuresPerAddress: { max: 100, perVerified: 1, ceiling: 500, windowSeconds: 900 },
    });
  });

  it("lets an email code earn only email room at the address (ADR-691)", () => {
    const [, , address] = sendCounts(keys, EMAIL, ADDRESS, undefined);
    expect(address?.earned?.bucket).toBe(BUCKETS.playerVerifiedEmailAddress);
    const [, , failures] = failureCounts(keys, EMAIL, ADDRESS);
    expect(failures?.earned?.bucket).toBe(BUCKETS.playerVerifiedEmailAddress);
  });

  it("opens room per right code from the base up to the ceiling, never past it", () => {
    const earned = { bucket: BUCKETS.playerVerifiedPhoneAddress, perVerified: 2, ceiling: 2000 };
    expect(earnedLimit(200, earned, 0)).toBe(200);
    expect(earnedLimit(200, earned, 1)).toBe(202);
    expect(earnedLimit(200, earned, 50)).toBe(300);
    expect(earnedLimit(200, earned, 899)).toBe(1998);
    expect(earnedLimit(200, earned, 900)).toBe(2000);
    expect(earnedLimit(200, earned, 5000)).toBe(2000);
  });
});
