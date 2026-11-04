// One load driver process (T-804), started by ops/load/run.mjs: `node ops/load/driver.mjs <job.json> <result.json>`.
// `completions`: each of its events gets an open stream of quest completions at the job's rate, plus a ranking probe
// every few seconds. `rush`: POST /v1/auth/code at stepped rates. Every latency is written raw; run.mjs merges them.
import { readFileSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { createClient, playerHeaders } from "./http.mjs";
import { addressOf, dueCount, intendedAt, phoneOf, slotOf } from "./schedule.mjs";

const TICK_MS = 1;
const PROBE_POLL_MS = 100;
const PROBE_GIVE_UP_MS = 15_000;
/** The probe quest allows 100 completions; stop short of the cap. */
const PROBE_LIMIT = 95;

const round = (/** @type {number} */ ms) => Math.round(ms * 10) / 10;
const count = (/** @type {Record<string, number>} */ into, /** @type {string} */ key) => {
  into[key] = (into[key] ?? 0) + 1;
};

/** The shared measurement record of one driver. */
function newResult() {
  return {
    completions: { fromIntended: [], fromSent: [], confirmedMs: [], statuses: {}, measured: 0 },
    probes: { afterConfirm: [], afterSend: [], gaveUp: 0, failed: 0 },
    reads: { statuses: {} },
    lagMs: [],
    rush: [],
  };
}

/**
 * Runs `total` requests on an open schedule at `ratePerSecond`; `fire(index, intendedMs)` sends one and returns its
 * promise. Requests past `maxInFlight` unanswered are not sent and are counted by `shed(index)`.
 */
async function openStream(spec, fire, shed) {
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

/** One event's completion stream; only completions intended after the warm-up are measured. */
function completionStream(job, event, client, result) {
  const { players, quests } = { players: event.tokens.length, quests: event.quests.length };
  const ratePerSecond = job.ratePerEventPerMinute / 60;
  const warmup = Math.floor(ratePerSecond * job.warmupSeconds);
  const total = Math.min(
    players * quests,
    warmup + Math.floor(ratePerSecond * job.durationSeconds),
  );
  const c = result.completions;
  const fire = async (index, intendedMs) => {
    const pair = slotOf(index, players, quests);
    const quest = event.quests[pair.quest];
    const sentMs = performance.now();
    result.lagMs.push(round(sentMs - intendedMs));
    const answer = await client.send(
      "POST",
      `/v1/quests/${quest.id}/complete`,
      playerHeaders(event.tokens[pair.player]),
      { proof: { type: "qr", code: quest.code } },
    );
    if (index < warmup) return;
    const doneMs = performance.now();
    c.measured += 1;
    count(c.statuses, answer.status);
    c.fromIntended.push(round(doneMs - intendedMs));
    c.fromSent.push(round(doneMs - sentMs));
    if (answer.status === "200") c.confirmedMs.push(round(doneMs - intendedMs));
  };
  const shed = (index) => {
    if (index >= warmup) {
      c.measured += 1;
      count(c.statuses, "client_shed");
    }
  };
  return openStream({ ratePerSecond, total, maxInFlight: job.maxInFlight }, fire, shed);
}

/** Polls the board as another player until the probe leads it with at least `score`; the ms it took, or null. */
async function seenOnBoard(client, event, score) {
  const started = performance.now();
  const reader = event.tokens.at(-1);
  while (performance.now() - started < PROBE_GIVE_UP_MS) {
    const answer = await client.send("GET", `/v1/events/${event.id}/ranking`, {
      authorization: `Bearer ${reader}`,
    });
    if (answer.status === "200") {
      const top = JSON.parse(answer.body).rows?.[0];
      if (top?.username === event.probe.username && top.score >= score) {
        return performance.now();
      }
    }
    await sleep(PROBE_POLL_MS);
  }
  return null;
}

/** Every `probeEveryMs` until `endMs`, the probe completes its 5,000-point quest and waits to lead the board. */
async function probeLoop(job, event, client, result, endMs) {
  const p = result.probes;
  for (let n = 0; n < PROBE_LIMIT && performance.now() < endMs; n += 1) {
    const next = performance.now() + job.probeEveryMs;
    const sentMs = performance.now();
    const { quest, token } = event.probe;
    const answer = await client.send(
      "POST",
      `/v1/quests/${quest.id}/complete`,
      playerHeaders(token),
      {
        proof: { type: "qr", code: quest.code },
      },
    );
    if (answer.status !== "200") {
      p.failed += 1;
    } else {
      const confirmedMs = performance.now();
      const seenMs = await seenOnBoard(client, event, JSON.parse(answer.body).score);
      if (seenMs === null) {
        p.gaveUp += 1;
      } else {
        p.afterConfirm.push(round(seenMs - confirmedMs));
        p.afterSend.push(round(seenMs - sentMs));
      }
    }
    await sleep(Math.max(0, next - performance.now()));
  }
}

async function runCompletions(job, result) {
  const endMs = performance.now() + (job.warmupSeconds + job.durationSeconds) * 1000;
  const clients = job.baseUrls.map((url) => createClient(url, job.sockets));
  const work = job.events.flatMap((event, i) => {
    const client = clients[i % clients.length];
    return [
      completionStream(job, event, client, result),
      probeLoop(job, event, client, result, endMs),
    ];
  });
  await Promise.all(work);
  for (const client of clients) client.close();
}

/** One rush step: `seconds` of POST /v1/auth/code at `ratePerSecond`, each from a new phone. */
async function rushStep(job, client, step, firstIndex) {
  const measured = { ratePerSecond: step.ratePerSecond, fromIntended: [], statuses: {} };
  const total = Math.round(step.ratePerSecond * step.seconds);
  const fire = async (offset, intendedMs) => {
    const index = firstIndex + offset;
    const answer = await client.send(
      "POST",
      "/v1/auth/code",
      { "x-forwarded-for": addressOf(index, job.rush.perAddress) },
      { channel: "phone", value: phoneOf(index), lang: "ar", accept: job.rush.accept },
    );
    count(measured.statuses, answer.status);
    measured.fromIntended.push(round(performance.now() - intendedMs));
  };
  const shed = () => count(measured.statuses, "client_shed");
  await openStream(
    { ratePerSecond: step.ratePerSecond, total, maxInFlight: job.maxInFlight },
    fire,
    shed,
  );
  return { measured, sent: total };
}

async function runRush(job, result) {
  const client = createClient(job.baseUrls[0], job.sockets);
  let index = job.rush.firstIndex;
  for (const step of job.rush.steps) {
    const { measured, sent } = await rushStep(job, client, step, index);
    result.rush.push(measured);
    index += sent;
  }
  client.close();
}

async function main() {
  const [jobFile, resultFile] = process.argv.slice(2);
  if (jobFile === undefined || resultFile === undefined) {
    throw new Error("Usage: node ops/load/driver.mjs <job.json> <result.json>");
  }
  const job = JSON.parse(readFileSync(jobFile, "utf8"));
  const result = newResult();
  const cpuBefore = process.cpuUsage();
  await (job.mode === "rush" ? runRush(job, result) : runCompletions(job, result));
  const cpu = process.cpuUsage(cpuBefore);
  writeFileSync(resultFile, JSON.stringify({ ...result, cpuMs: (cpu.user + cpu.system) / 1000 }));
}

main().catch((error) => {
  process.stderr.write(`driver: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
