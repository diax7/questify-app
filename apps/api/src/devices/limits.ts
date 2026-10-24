import type { Pool } from "pg";
import { tooManyAttempts } from "#src/auth/http-errors";
import { BUCKETS, countRecent, record, tryLock, type Bucket } from "#src/auth/throttle";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";

/** At most `max` attempts in `windowSeconds`, counted in `bucket` under a keyed hash. */
export type DeviceLimit = Readonly<{ bucket: Bucket; max: number; windowSeconds: number }>;

/** The limits of pairing and the screen code (T-309, API.md). */
export const DEVICE_LIMITS = {
  /** Pairing requests from one address bucket: a venue's screens share one address behind its NAT (CTO 4). */
  requestsPerAddress: { bucket: BUCKETS.deviceRequest, max: 60, windowSeconds: 600 },
  /** A device's polls of its own state. */
  pollsPerDevice: { bucket: BUCKETS.devicePoll, max: 30, windowSeconds: 60 },
  /** A device's renews and activations (CTO code review 1): a page needs one of each every 10 minutes at most. */
  writesPerDevice: { bucket: BUCKETS.deviceWrite, max: 10, windowSeconds: 60 },
  /** A station's code fetches, and an operator's for one quest. */
  codesPerDevice: { bucket: BUCKETS.deviceScreenCode, max: 6, windowSeconds: 60 },
  codesPerOperatorQuest: { bucket: BUCKETS.operatorScreenCode, max: 6, windowSeconds: 60 },
  /** Claims and previews by one staff member or operator. */
  claimsPerActor: { bucket: BUCKETS.deviceClaim, max: 10, windowSeconds: 60 },
  /** Unknown codes tried against one event and one organizer (CTO 8). */
  missesPerEvent: { bucket: BUCKETS.deviceMissEvent, max: 30, windowSeconds: 3600 },
  missesPerOrganizer: { bucket: BUCKETS.deviceMissOrganizer, max: 30, windowSeconds: 3600 },
  /** Above this many unknown codes an hour on the whole platform, ops are alerted (`device.claim_misses_high`). */
  missesPlatformAlert: { bucket: BUCKETS.deviceMissPlatform, max: 200, windowSeconds: 3600 },
} as const satisfies Readonly<Record<string, DeviceLimit>>;

/**
 * Holds one attempt against each limit in its own short transaction, under a non-waiting lock on the first key, and
 * records it in each when `keep`. The wait goes on `reply` as Retry-After.
 *
 * @throws HttpError `too_many_attempts` (with the seconds to wait) when a limit is reached or the key is busy.
 */
export async function holdBack(
  pool: Pool,
  limits: ReadonlyArray<Readonly<{ limit: DeviceLimit; key: Buffer }>>,
  keep: boolean,
  reply?: Readonly<{ header: (name: string, value: string) => unknown }>,
): Promise<void> {
  const wait = await withConnection(pool, (client) =>
    withRequestContext(client, {}, async () => {
      const first = limits[0];
      if (first !== undefined && !(await tryLock(client, first.key))) {
        return 1;
      }
      for (const { limit, key } of limits) {
        const window = await countRecent(client, limit.bucket, key, limit.windowSeconds);
        if (window.count >= limit.max) {
          return window.retryAfterSeconds;
        }
      }
      if (keep) {
        for (const { limit, key } of limits) {
          await record(client, limit.bucket, key);
        }
      }
      return undefined;
    }),
  );
  if (wait !== undefined) {
    reply?.header("retry-after", String(wait));
    throw tooManyAttempts({ retryAfterSeconds: wait });
  }
}

/** Records one attempt in a bucket and answers how many it now holds in the window (the platform's alarm counter). */
export async function countOne(pool: Pool, limit: DeviceLimit, key: Buffer): Promise<number> {
  return withConnection(pool, (client) =>
    withRequestContext(client, {}, async () => {
      await record(client, limit.bucket, key);
      return (await countRecent(client, limit.bucket, key, limit.windowSeconds)).count;
    }),
  );
}
