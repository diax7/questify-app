// Rate control for the load test (T-804). The load is open: each request has an intended send time fixed in advance,
// it is sent then whether or not earlier ones have answered, and its latency is measured from that intended time. A
// slow server therefore shows up as latency, never as a quietly lower rate (no coordinated omission).
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";

const TICK_MS = 1;

/**
 * How many of a stream's requests are due at `nowMs`: request i is intended at `startMs + i * 1000 / ratePerSecond`,
 * and the stream holds `total` requests.
 *
 * @param {Readonly<{ startMs: number; ratePerSecond: number; total: number }>} stream
 * @param {number} nowMs
 * @returns {number} from 0 to `total`
 */
export function dueCount(stream, nowMs) {
  const { startMs, ratePerSecond, total } = stream;
  if (!(ratePerSecond > 0)) {
    throw new RangeError(`A rate is above 0 requests a second; got ${ratePerSecond}.`);
  }
  if (nowMs < startMs) {
    return 0;
  }
  return Math.min(total, Math.floor(((nowMs - startMs) * ratePerSecond) / 1000) + 1);
}

/**
 * The intended send time of request `index` of a stream.
 *
 * @param {Readonly<{ startMs: number; ratePerSecond: number }>} stream
 * @param {number} index
 */
export function intendedAt(stream, index) {
  return stream.startMs + (index * 1000) / stream.ratePerSecond;
}

/**
 * The player and quest of an event's completion number `slot`: players first, then the next quest, so no player
 * completes a quest twice (each load quest allows one completion) until every pair is used.
 *
 * @param {number} slot from 0
 * @param {number} players players in the event
 * @param {number} quests load quests in the event
 * @returns {{ player: number; quest: number } | null} null once every pair is used
 */
export function slotOf(slot, players, quests) {
  if (slot < 0 || slot >= players * quests) {
    return null;
  }
  return { player: slot % players, quest: Math.floor(slot / players) };
}

/**
 * The client address of sign-in request `index` when each address sends `perAddress` requests: 10.0.0.1 onwards, the
 * way phones behind a carrier's shared addresses arrive.
 *
 * @param {number} index from 0
 * @param {number} perAddress at least 1
 */
export function addressOf(index, perAddress) {
  const n = Math.floor(index / perAddress) + 1;
  return `10.${Math.floor(n / 65_536) % 256}.${Math.floor(n / 256) % 256}.${n % 256}`;
}

/**
 * The Saudi mobile number of sign-in request `index`: +9665 9xxxxxxx, outside the seeded players' numbers.
 *
 * @param {number} index from 0 to 9,999,999
 */
export function phoneOf(index) {
  return `+96659${String(index).padStart(7, "0")}`;
}

/**
 * The contact of sign-in request `index` on a channel: `phoneOf(index)`, or a new email address.
 *
 * @param {number} index from 0 to 9,999,999
 * @param {"phone" | "email"} channel
 */
export function contactOf(index, channel) {
  return channel === "email" ? `rush${index}@najd.sa` : phoneOf(index);
}

/**
 * Runs `total` requests on an open schedule at `ratePerSecond`; `fire(index, intendedMs)` sends one and returns its
 * promise. Requests past `maxInFlight` unanswered are not sent and are counted by `shed(index)`.
 */
export async function openStream(spec, fire, shed) {
  const stream = {
    startMs: performance.now(),
    ratePerSecond: spec.ratePerSecond,
    total: spec.total,
  };
  const pending = new Set();
  let sent = 0;
  while (sent < stream.total) {
    const due = dueCount(stream, performance.now());
    for (; sent < due; sent += 1) {
      if (pending.size >= spec.maxInFlight) {
        shed(sent);
        continue;
      }
      const promise = fire(sent, intendedAt(stream, sent));
      pending.add(promise);
      void promise.finally(() => pending.delete(promise));
    }
    await sleep(TICK_MS);
  }
  await Promise.all(pending);
}
