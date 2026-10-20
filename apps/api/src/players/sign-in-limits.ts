import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import type { AuthKeys } from "#src/auth/keys";
import { PLAYER_SIGN_IN_LIMITS } from "#src/auth/limits";
import { addressBucket } from "#src/auth/normalize";
import { BUCKETS, countRecent, record, type Bucket } from "#src/auth/throttle";

export type Channel = "phone" | "email";
export type Throttled = Readonly<{ kind: "throttled"; retryAfterSeconds: number }>;

type Limit = Readonly<{ max: number; windowSeconds: number }>;
/** One sliding window a request is held against. */
export type Count = Readonly<{ bucket: Bucket; key: Buffer; limit: Limit }>;

const L = PLAYER_SIGN_IN_LIMITS;

/** The windows every code sent counts in, first or resent (M3): the contact, the install, the client address. */
export function sendCounts(
  keys: AuthKeys,
  contact: string,
  address: string,
  deviceId: string | undefined,
): Count[] {
  const contactKey = keys.contactThrottleKey(contact);
  const counts: Count[] = [
    { bucket: BUCKETS.playerCodeContact, key: contactKey, limit: L.codesPerContactHour },
    // The same rows as the hour, in a longer window: one bucket per window would record every send twice.
    { bucket: BUCKETS.playerCodeContact, key: contactKey, limit: L.codesPerContactDay },
    {
      bucket: BUCKETS.playerCodeAddress,
      key: keys.addressKey(addressBucket(address)),
      limit: L.codesPerAddressHour,
    },
  ];
  if (deviceId !== undefined) {
    counts.push({
      bucket: BUCKETS.playerCodeDevice,
      key: keys.deviceKey(deviceId),
      limit: L.codesPerDeviceHour,
    });
  }
  return counts;
}

/** The windows a wrong code counts in: the contact (15 minutes and a day) and the client address. */
export function failureCounts(keys: AuthKeys, contact: string, address: string): Count[] {
  const contactKey = keys.contactThrottleKey(contact);
  return [
    { bucket: BUCKETS.playerFailContact, key: contactKey, limit: L.failuresPerContact },
    { bucket: BUCKETS.playerFailContact, key: contactKey, limit: L.failuresPerContactDay },
    {
      bucket: BUCKETS.playerFailAddress,
      key: keys.addressKey(addressBucket(address)),
      limit: L.failuresPerAddress,
    },
  ];
}

/** The first full window, with how long until it has room; undefined when every window has room. */
export async function firstFull(
  client: PoolClient,
  counts: readonly Count[],
): Promise<Throttled | undefined> {
  for (const { bucket, key, limit } of counts) {
    const window = await countRecent(client, bucket, key, limit.windowSeconds);
    if (window.count >= limit.max) {
      return { kind: "throttled", retryAfterSeconds: window.retryAfterSeconds };
    }
  }
  return undefined;
}

/** Records one attempt in each distinct bucket and key (two windows over one bucket share its rows). */
export async function recordAll(client: PoolClient, counts: readonly Count[]): Promise<void> {
  const seen = new Set<string>();
  for (const { bucket, key } of counts) {
    const id = `${bucket}:${key.toString("hex")}`;
    if (!seen.has(id)) {
      seen.add(id);
      await record(client, bucket, key);
    }
  }
}

const globalKey = (name: string): Buffer => createHash("sha256").update(name).digest();

const PLATFORM = {
  phone: {
    bucket: BUCKETS.smsPlatform,
    key: globalKey("questify.sms_platform"),
    limit: L.smsPerHour,
  },
  email: {
    bucket: BUCKETS.playerEmailPlatform,
    key: globalKey("questify.player_email_platform"),
    limit: L.playerEmailsPerDay,
  },
} as const;

export type Budget = "taken" | "half" | "spent";

/**
 * Takes one message from the platform's budget for the channel: login SMS an hour (the SMS-pumping brake, ADR-099) or
 * player email codes a day (ADR-117). Requests wait their turn for the one counter (`takeOutboundMail`'s pattern), so a
 * burst cannot overshoot it. `half` is a taken message that reached half the budget, for a warning in the log.
 */
export async function takePlatformBudget(client: PoolClient, channel: Channel): Promise<Budget> {
  const { bucket, key, limit } = PLATFORM[channel];
  await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [
    key.readBigInt64BE(0).toString(),
  ]);
  const used = await countRecent(client, bucket, key, limit.windowSeconds);
  if (used.count >= limit.max) {
    return "spent";
  }
  await record(client, bucket, key);
  return used.count + 1 === Math.floor(limit.max / 2) ? "half" : "taken";
}
