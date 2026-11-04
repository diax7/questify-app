import { setTimeout as sleep } from "node:timers/promises";
import type { PoolClient } from "pg";
import type { AuthKeys } from "#src/auth/keys";
import { PLAYER_SIGN_IN_LIMITS } from "#src/auth/limits";
import { addressBucket } from "#src/auth/normalize";
import { reasonOf, say, type Caller } from "#src/auth/sign-in";
import {
  BUCKETS,
  countRecent,
  countWindows,
  forget,
  record,
  recordMany,
  type Bucket,
} from "#src/auth/throttle";
import { onlyRow } from "#src/db/rows";

export type Channel = "phone" | "email";
export type Throttled = Readonly<{ kind: "throttled"; retryAfterSeconds: number }>;
export type Unavailable = Readonly<{ kind: "sms_unavailable" | "email_unavailable" }>;
type Contact = Readonly<{ channel: Channel; value: string }>;

type Limit = Readonly<{ max: number; windowSeconds: number }>;
/** Room a window earns (ADR-691): `perVerified` more for each row of `bucket` under the same key, up to `ceiling`. */
type Earned = Readonly<{ bucket: Bucket; perVerified: number; ceiling: number }>;
/** One sliding window a request is held against. */
export type Count = Readonly<{ bucket: Bucket; key: Buffer; limit: Limit; earned?: Earned }>;

const L = PLAYER_SIGN_IN_LIMITS;

/** Where a right code of the channel earns its address room: an SMS code earns SMS room, an email code email room. */
const VERIFIED: Readonly<Record<Channel, Bucket>> = {
  phone: BUCKETS.playerVerifiedPhoneAddress,
  email: BUCKETS.playerVerifiedEmailAddress,
};

const earnedBy = (
  channel: Channel,
  limit: Readonly<{ perVerified: number; ceiling: number }>,
): Earned => ({
  bucket: VERIFIED[channel],
  perVerified: limit.perVerified,
  ceiling: limit.ceiling,
});

/** The windows every code sent counts in, first or resent (M3): the contact, the install, the client address. */
export function sendCounts(
  keys: AuthKeys,
  contact: Contact,
  address: string,
  deviceId: string | undefined,
): Count[] {
  const contactKey = keys.contactThrottleKey(contact.value);
  const counts: Count[] = [
    { bucket: BUCKETS.playerCodeContact, key: contactKey, limit: L.codesPerContactHour },
    // The same rows as the hour, in a longer window: one bucket per window would record every send twice.
    { bucket: BUCKETS.playerCodeContact, key: contactKey, limit: L.codesPerContactDay },
    {
      bucket: BUCKETS.playerCodeAddress,
      key: keys.addressKey(addressBucket(address)),
      limit: L.codesPerAddressHour,
      earned: earnedBy(contact.channel, L.codesPerAddressHour),
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
export function failureCounts(keys: AuthKeys, contact: Contact, address: string): Count[] {
  const contactKey = keys.contactThrottleKey(contact.value);
  return [
    { bucket: BUCKETS.playerFailContact, key: contactKey, limit: L.failuresPerContact },
    { bucket: BUCKETS.playerFailContact, key: contactKey, limit: L.failuresPerContactDay },
    {
      bucket: BUCKETS.playerFailAddress,
      key: keys.addressKey(addressBucket(address)),
      limit: L.failuresPerAddress,
      earned: earnedBy(contact.channel, L.failuresPerAddress),
    },
  ];
}

/** A window's limit with the room it earned: the earned rows are read only once the base is reached. */
export function earnedLimit(base: number, earned: Earned, verified: number): number {
  return Math.min(earned.ceiling, base + earned.perVerified * verified);
}

/**
 * The first full window, with how long until it has room; undefined when every window has room. Every window is read
 * in one round trip; a window's earned room is read only once its base is reached.
 */
export async function firstFull(
  client: PoolClient,
  counts: readonly Count[],
): Promise<Throttled | undefined> {
  const windows = await countWindows(
    client,
    counts.map(({ bucket, key, limit }) => ({ bucket, key, windowSeconds: limit.windowSeconds })),
  );
  for (const [i, { key, limit, earned }] of counts.entries()) {
    const window = windows[i];
    // Stryker disable next-line ConditionalExpression: defence in depth: the query answers one row per window
    if (window === undefined || window.count < limit.max) {
      continue;
    }
    if (earned !== undefined) {
      const verified = await countRecent(client, earned.bucket, key, limit.windowSeconds);
      if (window.count < earnedLimit(limit.max, earned, verified.count)) {
        continue;
      }
    }
    return { kind: "throttled", retryAfterSeconds: window.retryAfterSeconds };
  }
  return undefined;
}

/** Records one attempt in each distinct bucket and key (two windows over one bucket share its rows), in one insert. */
export async function recordAll(client: PoolClient, counts: readonly Count[]): Promise<void> {
  const seen = new Set<string>();
  const attempts = counts.filter(({ bucket, key }) => {
    const id = `${bucket}:${key.toString("hex")}`;
    const first = !seen.has(id);
    seen.add(id);
    return first;
  });
  await recordMany(client, attempts);
}

/**
 * Counts a right code typed from the address (ADR-691), inside the caller's transaction and under its lock on the
 * contact: each contact earns its channel's room once a window, so retyping or resigning in earns nothing more.
 */
export async function recordVerified(
  client: PoolClient,
  keys: AuthKeys,
  contact: Contact,
  address: string,
): Promise<void> {
  const contactKey = keys.contactThrottleKey(contact.value);
  const once = L.codesPerAddressHour.windowSeconds;
  const seen = await countRecent(client, BUCKETS.playerVerifiedContact, contactKey, once);
  if (seen.count > 0) {
    return;
  }
  await record(client, BUCKETS.playerVerifiedContact, contactKey);
  await record(client, VERIFIED[contact.channel], keys.addressKey(addressBucket(address)));
}

const PLATFORM: Readonly<Record<Channel, Bucket>> = {
  phone: BUCKETS.smsPlatform,
  email: BUCKETS.playerEmailPlatform,
};

/** Calls after the first `busy`, each its own statement and transaction, so no lock is held between them (ADR-692). */
const BUSY_RETRIES = 3;
const RETRY_MIN_MS = 5;
const RETRY_SPREAD_MS = 15;

/** One unit of the platform budget, held until the send goes or given back. */
export type Held = Readonly<{ kind: "held"; channel: Channel; key: Buffer; at: string }>;
export type Reserved = Held | Readonly<{ kind: "spent" | "busy" }>;

/**
 * Takes one message from the platform's budget for the channel (login SMS an hour, the SMS-pumping brake, ADR-099;
 * player email codes a day, ADR-117) with `take_send_budget` (migration 0150): one autocommit statement on `client`,
 * which must not be inside a transaction. It never waits for a lock; `busy` is retried with jitter and returned only
 * after the last try, and `spent` means every stripe was full (ADR-690, ADR-692).
 */
export async function reserveSend(client: PoolClient, channel: Channel): Promise<Reserved> {
  for (let attempt = 0; ; attempt += 1) {
    const { rows } = await client.query<{
      outcome: "taken" | "busy" | "spent";
      stripe_key: Buffer | null;
      taken_at: string | null;
    }>("SELECT outcome, stripe_key, taken_at FROM take_send_budget($1)", [channel]);
    const row = onlyRow(rows, "take_send_budget");
    if (row.outcome === "taken" && row.stripe_key !== null && row.taken_at !== null) {
      return { kind: "held", channel, key: row.stripe_key, at: row.taken_at };
    }
    if (row.outcome === "spent" || attempt >= BUSY_RETRIES) {
      return { kind: row.outcome === "spent" ? "spent" : "busy" };
    }
    await sleep(RETRY_MIN_MS + Math.random() * RETRY_SPREAD_MS);
  }
}

/** Gives a held unit back: one DELETE of its row, so a refused request leaves the budget where it was. */
export async function giveBack(client: PoolClient, held: Held): Promise<void> {
  await forget(client, PLATFORM[held.channel], held.key, held.at);
}

type BudgetScope = Readonly<{
  deps: Readonly<{ keys: AuthKeys }>;
  asker: Caller;
  /** A connection outside any transaction: the reservation and the give-back are their own statements. */
  client: PoolClient;
  channel: Channel;
}>;

/**
 * Runs `work` (the request's own transaction) holding one unit of the platform budget. The unit stays used only when
 * `sends(result)` says the message goes; on any other answer or an error it is given back after the transaction ended
 * (best effort: a failed give-back is logged and the unit stays used, so errors can only under-spend). A spent budget
 * answers `sms_unavailable` or `email_unavailable`; a budget still busy after the retries answers `throttled`.
 */
export async function withSendBudget<T>(
  scope: BudgetScope,
  work: () => Promise<T>,
  sends: (result: T) => boolean,
): Promise<T | Throttled | Unavailable> {
  const { client, channel } = scope;
  const reserved = await reserveSend(client, channel);
  if (reserved.kind !== "held") {
    return refusalOf(scope, reserved.kind);
  }
  let result: T;
  try {
    result = await work();
  } catch (error) {
    await giveBackLogged(scope, reserved);
    throw error;
  }
  if (!sends(result)) {
    await giveBackLogged(scope, reserved);
  }
  return result;
}

function refusalOf(scope: BudgetScope, outcome: "spent" | "busy"): Throttled | Unavailable {
  const { deps, asker, channel } = scope;
  if (outcome === "busy") {
    say(deps, asker, "player.budget_busy", { channel });
    return { kind: "throttled", retryAfterSeconds: 1 };
  }
  say(deps, asker, "player.budget_spent", { channel });
  return { kind: channel === "phone" ? "sms_unavailable" : "email_unavailable" };
}

async function giveBackLogged(scope: BudgetScope, held: Held): Promise<void> {
  try {
    await giveBack(scope.client, held);
  } catch (error) {
    say(scope.deps, scope.asker, "player.budget_give_back_failed", {
      channel: held.channel,
      reason: reasonOf(error),
    });
  }
}
