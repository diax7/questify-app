// The ranking probe of a completions driver (T-804, NFR-005): one player completes its 5,000-point quest every few
// seconds and waits to lead the board. Split from driver.mjs so a test can run it on a clock it controls.
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { playerHeaders } from "./http.mjs";

const PROBE_POLL_MS = 100;
const PROBE_GIVE_UP_MS = 15_000;
/** The probe quest allows 100 completions; stop short of the cap. */
const PROBE_LIMIT = 95;

const round = (/** @type {number} */ ms) => Math.round(ms * 10) / 10;

/** @typedef {{ now: () => number; sleep: (ms: number) => Promise<unknown> }} Clock */
/** @type {Clock} */
const REAL_CLOCK = { now: () => performance.now(), sleep: (ms) => sleep(ms) };

/** Polls the board as another player until the probe leads it with at least `score`; the time it was seen, or null. */
async function seenOnBoard(client, event, score, clock) {
  const started = clock.now();
  const reader = event.tokens.at(-1);
  while (clock.now() - started < PROBE_GIVE_UP_MS) {
    const answer = await client.send("GET", `/v1/events/${event.id}/ranking`, {
      authorization: `Bearer ${reader}`,
    });
    if (answer.status === "200") {
      const top = JSON.parse(answer.body).rows?.[0];
      if (top?.username === event.probe.username && top.score >= score) return clock.now();
    }
    await clock.sleep(PROBE_POLL_MS);
  }
  return null;
}

/**
 * The window the probe works in, as times on the clock: it sleeps through the warm-up (the completion stream does not
 * measure it, so a probe there would count in the ranking figures but not in the completion ones) and stops starting
 * probes when the measured window ends.
 *
 * @param {{ warmupSeconds: number; durationSeconds: number }} job
 * @param {number} beginMs when the driver started its streams
 */
export const probeWindow = (job, beginMs) => ({
  startMs: beginMs + job.warmupSeconds * 1000,
  endMs: beginMs + (job.warmupSeconds + job.durationSeconds) * 1000,
});

/**
 * From the end of the warm-up until `window.endMs`, every `probeEveryMs` the probe completes its quest and waits to
 * lead the board.
 */
export async function probeLoop(job, event, client, result, window, clock = REAL_CLOCK) {
  const p = result.probes;
  await clock.sleep(Math.max(0, window.startMs - clock.now()));
  for (let n = 0; n < PROBE_LIMIT && clock.now() < window.endMs; n += 1) {
    const next = clock.now() + job.probeEveryMs;
    const sentMs = clock.now();
    const { quest, token } = event.probe;
    const answer = await client.send(
      "POST",
      `/v1/quests/${quest.id}/complete`,
      playerHeaders(token),
      { proof: { type: "qr", code: quest.code } },
    );
    if (answer.status !== "200") {
      p.failed += 1;
    } else {
      const confirmedMs = clock.now();
      const seenMs = await seenOnBoard(client, event, JSON.parse(answer.body).score, clock);
      if (seenMs === null) {
        p.gaveUp += 1;
      } else {
        p.afterConfirm.push(round(seenMs - confirmedMs));
        p.afterSend.push(round(seenMs - sentMs));
      }
    }
    await clock.sleep(Math.max(0, next - clock.now()));
  }
}
