import { setTimeout as sleep } from "node:timers/promises";
import type { PoolClient } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAuthKeys } from "#src/auth/keys";
import { PLAYER_SIGN_IN_LIMITS as L } from "#src/auth/limits";
import { addressBucket } from "#src/auth/normalize";
import type { AuthLog } from "#src/auth/sign-in";
import { BUCKETS } from "#src/auth/throttle";
import {
  earnedLimit,
  failureCounts,
  reserveSend,
  sendCounts,
  withSendBudget,
  type Channel,
} from "#src/players/sign-in-limits";
import { fakePool, type FakeAnswer } from "#test/support/fake-pool";

vi.mock("node:timers/promises", () => ({ setTimeout: vi.fn(() => Promise.resolve()) }));

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

const BUSY: FakeAnswer = { rows: [{ outcome: "busy", stripe_key: null, taken_at: null }] };
const SPENT: FakeAnswer = { rows: [{ outcome: "spent", stripe_key: null, taken_at: null }] };
const STRIPE = Buffer.alloc(32, 7);
const TAKEN_AT = "2026-11-04 10:00:00+00";
const TAKEN: FakeAnswer = {
  rows: [{ outcome: "taken", stripe_key: STRIPE, taken_at: TAKEN_AT }],
};

/** A connection that answers each statement from `answer`, with the SQL it was sent. */
async function connectionAnswering(answer: (sql: string) => FakeAnswer) {
  const { pool, queries } = fakePool((sql) => answer(sql));
  return { client: await pool.connect(), queries };
}

const takesIn = (queries: readonly string[]) =>
  queries.filter((sql) => sql.includes("take_send_budget")).length;

const sleptMs = () => vi.mocked(sleep).mock.calls.map(([ms]) => ms);

afterEach(() => {
  vi.mocked(sleep).mockClear();
  vi.restoreAllMocks();
});

describe("reserving one unit of the platform send budget", () => {
  it("answers spent at once: no second try, no wait", async () => {
    const { client, queries } = await connectionAnswering(() => SPENT);
    expect(await reserveSend(client, "phone")).toEqual({ kind: "spent" });
    expect(takesIn(queries)).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("tries a busy budget three more times, waiting between tries, then answers busy", async () => {
    const { client, queries } = await connectionAnswering(() => BUSY);
    expect(await reserveSend(client, "phone")).toEqual({ kind: "busy" });
    expect(takesIn(queries)).toBe(4);
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  it("waits 5 to 20 ms between tries, spread by chance", async () => {
    vi.spyOn(Math, "random")
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0.5)
      .mockReturnValueOnce(0.999);
    const { client } = await connectionAnswering(() => BUSY);
    await reserveSend(client, "email");
    const [first, second, third] = sleptMs();
    expect(first).toBeCloseTo(5, 5);
    expect(second).toBeCloseTo(12.5, 5);
    expect(third).toBeCloseTo(19.985, 5);
  });

  it("follows a busy answer with whatever the next try answers", async () => {
    let tries = 0;
    const spent = await connectionAnswering(() => (++tries < 3 ? BUSY : SPENT));
    expect(await reserveSend(spent.client, "phone")).toEqual({ kind: "spent" });
    expect(takesIn(spent.queries)).toBe(3);
    tries = 0;
    const held = await connectionAnswering(() => (++tries < 2 ? BUSY : TAKEN));
    expect(await reserveSend(held.client, "email")).toEqual({
      kind: "held",
      channel: "email",
      key: STRIPE,
      at: TAKEN_AT,
    });
  });
});

const scopeOf = (client: PoolClient, channel: Channel, log: AuthLog) => ({
  deps: { keys },
  asker: { address: ADDRESS, userAgent: null, log },
  client,
  channel,
});

describe("holding the platform send budget around a request", () => {
  it.each(["phone", "email"] as const)(
    "answers a %s budget still busy after the tries with a one-second wait, running nothing",
    async (channel) => {
      const { client } = await connectionAnswering(() => BUSY);
      const log = vi.fn<AuthLog>();
      const work = vi.fn(() => Promise.resolve("sent"));
      const result = await withSendBudget(scopeOf(client, channel, log), work, () => true);
      expect(result).toEqual({ kind: "throttled", retryAfterSeconds: 1 });
      expect(work).not.toHaveBeenCalled();
      expect(log.mock.calls).toEqual([
        ["player.budget_busy", expect.objectContaining({ channel })],
      ]);
    },
  );

  it("logs a give-back that failed, with its channel and reason, and still answers", async () => {
    const { client, queries } = await connectionAnswering((sql) => {
      if (sql.includes("take_send_budget")) {
        return TAKEN;
      }
      throw Object.assign(new Error("connection lost"), { name: "ConnectionLost" });
    });
    const log = vi.fn<AuthLog>();
    const result = await withSendBudget(
      scopeOf(client, "phone", log),
      () => Promise.resolve("refused"),
      () => false,
    );
    expect(result).toBe("refused");
    expect(queries.some((sql) => sql.startsWith("DELETE FROM auth_throttle"))).toBe(true);
    expect(log.mock.calls).toEqual([
      [
        "player.budget_give_back_failed",
        expect.objectContaining({ channel: "phone", reason: "ConnectionLost" }),
      ],
    ]);
  });
});
