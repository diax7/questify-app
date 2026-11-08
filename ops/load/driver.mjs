// One load driver process (T-804), started by ops/load/run.mjs: `node ops/load/driver.mjs <job.json> <result.json>`.
// `completions`: each of its events gets an open stream of quest completions at the job's rate, plus a ranking probe
// every few seconds once the warm-up is over (probe.mjs). `rush`: POST /v1/auth/code at stepped rates, spread over the API instances; with `verify`, a share
// of the codes is typed back after a typing delay (T-804b). Every latency is written raw; run.mjs merges them.
import { readFileSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { createClient, playerHeaders } from "./http.mjs";
import { probeLoop, probeWindow } from "./probe.mjs";
import { addressOf, contactOf, openStream, slotOf } from "./schedule.mjs";

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
    verify: { asked: 0, statuses: {}, wrongFirst: 0, noCode: 0 },
  };
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

async function runCompletions(job, result) {
  const window = probeWindow(job, performance.now());
  const clients = job.baseUrls.map((url) => createClient(url, job.sockets));
  const work = job.events.flatMap((event, i) => {
    const client = clients[i % clients.length];
    return [
      completionStream(job, event, client, result),
      probeLoop(job, event, client, result, window),
    ];
  });
  await Promise.all(work);
  for (const client of clients) client.close();
}

/** Share of the typed-back codes that are typed wrong once first (a typo). */
const TYPO_SHARE = 0.05;

/**
 * Types a code back like a person (T-804b `--rush-verify`): after a delay drawn uniformly from the typing seconds, reads
 * the code the load API's stub "sent" and posts it, from the same address; a few type a wrong code first.
 */
async function typeBack(job, clients, result, sent) {
  const verify = job.rush.verify;
  const [min, max] = verify.typingSeconds;
  await sleep((min + Math.random() * (max - min)) * 1000);
  const v = result.verify;
  v.asked += 1;
  const found = await clients.codes[sent.instance].send(
    "GET",
    `/code?to=${encodeURIComponent(sent.contact)}`,
    {},
  );
  if (found.status !== "200") {
    v.noCode += 1;
    return;
  }
  const headers = { "x-forwarded-for": sent.address };
  const post = (code) =>
    clients.api[sent.instance].send("POST", "/v1/auth/verify", headers, {
      challengeToken: sent.challengeToken,
      code,
    });
  if (Math.random() < TYPO_SHARE) {
    v.wrongFirst += 1;
    count(v.statuses, (await post("000000")).status);
  }
  count(v.statuses, (await post(JSON.parse(found.body).code)).status);
}

/** One rush step: `seconds` of POST /v1/auth/code at `ratePerSecond`, each from a new phone or email. */
async function rushStep(job, clients, step, firstIndex, result) {
  const measured = {
    ratePerSecond: step.ratePerSecond,
    fromIntended: [],
    byStatus: {},
    statuses: {},
  };
  const total = Math.round(step.ratePerSecond * step.seconds);
  const verify = job.rush.verify;
  const fire = async (offset, intendedMs) => {
    const index = firstIndex + offset;
    const instance = index % clients.api.length;
    const contact = contactOf(index, job.rush.channel);
    const address = addressOf(index, job.rush.perAddress);
    const answer = await clients.api[instance].send(
      "POST",
      "/v1/auth/code",
      { "x-forwarded-for": address },
      { channel: job.rush.channel, value: contact, lang: "ar", accept: job.rush.accept },
    );
    const ms = round(performance.now() - intendedMs);
    count(measured.statuses, answer.status);
    measured.fromIntended.push(ms);
    (measured.byStatus[answer.status] ??= []).push(ms);
    if (verify !== null && answer.status === "202" && Math.random() < verify.share) {
      const { challengeToken } = JSON.parse(answer.body);
      result.typing.push(
        typeBack(job, clients, result, { instance, contact, address, challengeToken }),
      );
    }
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
  const clients = {
    api: job.baseUrls.map((url) => createClient(url, job.sockets)),
    codes: (job.rush.verify?.codeUrls ?? []).map((url) => createClient(url, 8)),
  };
  result.typing = [];
  let index = job.rush.firstIndex;
  for (const step of job.rush.steps) {
    const { measured, sent } = await rushStep(job, clients, step, index, result);
    result.rush.push(measured);
    index += sent;
  }
  await Promise.all(result.typing);
  delete result.typing;
  for (const client of [...clients.api, ...clients.codes]) client.close();
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
