import { describe, expect, it } from "vitest";
import { probeLoop, probeWindow } from "./probe.mjs";

const job = { warmupSeconds: 10, durationSeconds: 30, probeEveryMs: 5000 };
const event = {
  id: "event-1",
  tokens: ["player-token", "reader-token"],
  probe: { username: "probe", token: "probe-token", quest: { id: "quest-1", code: "code-1" } },
};

/** A clock that only moves when someone sleeps or a request takes its time, so nothing here waits for real. */
function fakeWorld() {
  let t = 1000;
  const sends: { method: string; atMs: number }[] = [];
  let score = 5000;
  const client = {
    async send(method: string, path: string) {
      sends.push({ method: `${method} ${path}`, atMs: t });
      t += 20;
      if (method === "POST") {
        score += 5000;
        return { status: "200", body: JSON.stringify({ score }) };
      }
      return { status: "200", body: JSON.stringify({ rows: [{ username: "probe", score }] }) };
    },
  };
  const clock = {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
  const result = { probes: { afterConfirm: [], afterSend: [], gaveUp: 0, failed: 0 } };
  return { client, clock, result, sends, begin: t };
}

describe("probeWindow", () => {
  it("starts when the warm-up ends and ends with the measured window", () => {
    expect(probeWindow(job, 1000)).toEqual({ startMs: 11_000, endMs: 41_000 });
  });
});

describe("probeLoop", () => {
  it("sends no probe during the warm-up, and the first one right after it", async () => {
    const { client, clock, result, sends, begin } = fakeWorld();
    await probeLoop(job, event, client, result, probeWindow(job, begin), clock);
    const completions = sends.filter((s) => s.method.startsWith("POST"));
    expect(completions.length).toBeGreaterThan(0);
    expect(completions[0]!.atMs).toBe(begin + job.warmupSeconds * 1000);
    expect(Math.min(...completions.map((s) => s.atMs))).toBeGreaterThanOrEqual(
      begin + job.warmupSeconds * 1000,
    );
  });

  it("stops starting probes when the measured window ends, every probe a probeEveryMs apart", async () => {
    const { client, clock, result, sends, begin } = fakeWorld();
    const window = probeWindow(job, begin);
    await probeLoop(job, event, client, result, window, clock);
    const starts = sends.filter((s) => s.method.startsWith("POST")).map((s) => s.atMs);
    expect(starts.length).toBe(Math.ceil((window.endMs - window.startMs) / job.probeEveryMs));
    expect(Math.max(...starts)).toBeLessThan(window.endMs);
    for (let i = 1; i < starts.length; i += 1) {
      expect(starts[i]! - starts[i - 1]!).toBe(job.probeEveryMs);
    }
    expect(result.probes.afterConfirm.length).toBe(starts.length);
  });

  it("sends nothing when the whole window is already over", async () => {
    const { client, clock, result, sends, begin } = fakeWorld();
    await probeLoop(job, event, client, result, probeWindow(job, begin - 100_000), clock);
    expect(sends).toEqual([]);
  });
});
