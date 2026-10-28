import { MESSAGES, type PushTexts } from "@questify/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AckRow, FanOutResult, PushDoors } from "#src/push/doors";
import { createFakeProvider } from "#src/push/fake";
import type { ClaimedSend } from "#src/push/message";
import type { PushProvider } from "#src/push/provider";
import {
  PUSH_DUE_MS,
  PUSH_SETTLE_MS,
  missingPlatforms,
  startPushWorker,
  type PushWorkerDeps,
} from "#src/push/worker";
import type { SettingsService } from "#src/settings/service";

const TEXTS: PushTexts = {
  messages: { ...MESSAGES, "push.t.body": { ar: "رسالة", en: "A message" } },
  templates: { test_kind: { body: "push.t.body", nameless: "push.t.body" } },
};

const claimRow = (id: number): ClaimedSend => ({
  send_id: String(id),
  lease: `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`,
  lease_until: new Date(),
  target: "fcm",
  token: "fcm_token_1234567890",
  language: "ar",
  kind: "test_kind",
  class: "personal",
  topic: null,
  notification_id: String(id),
  event_id: null,
  refs: {},
  params: {},
  expires_at: new Date(Date.now() + 3_600_000),
  priority: 0,
  attempts: 0,
  terms: null,
  timezone: null,
});

describe("startPushWorker (ADR-345)", () => {
  let calls: string[];
  let fanOuts: FanOutResult[];
  let queue: ClaimedSend[];
  let acks: AckRow[][];
  let logs: Array<[string, Record<string, unknown>]>;
  let switchOn: boolean | undefined;
  let settleMore: number;
  let dueMore: number;
  let failFanOut: boolean;
  let failDue: boolean;

  const doors: PushDoors = {
    fanOut: () => {
      calls.push("fanOut");
      if (failFanOut) return Promise.reject(Object.assign(new Error("down"), { code: "57P01" }));
      return Promise.resolve(fanOuts.shift() ?? { rows: 0, more: false });
    },
    claim: (targets, size) => {
      calls.push(`claim:${targets.join(",")}:${size}`);
      return Promise.resolve(queue.splice(0, size));
    },
    ack: (rows) => {
      acks.push([...rows]);
      return Promise.resolve(rows.length);
    },
    settle: () => {
      calls.push("settle");
      settleMore -= 1;
      return Promise.resolve({ more: settleMore > 0 });
    },
    due: () => {
      calls.push("due");
      if (failDue) return Promise.reject(Object.assign(new Error("down"), { code: "57014" }));
      dueMore -= 1;
      return Promise.resolve({ ready: 500, ending: 0, more: dueMore > 0 });
    },
  };
  const settings: Pick<SettingsService, "forEvent"> = {
    forEvent: () =>
      Promise.resolve({
        kind: "ok",
        etag: "x",
        config: {
          features: switchOn === undefined ? {} : { pushNotifications: { enabled: switchOn } },
        },
      } as unknown as Awaited<ReturnType<SettingsService["forEvent"]>>),
  };
  const start = (providers: PushProvider[], extra: Partial<PushWorkerDeps> = {}) =>
    startPushWorker({
      doors,
      providers,
      settings,
      log: (level, fields) => logs.push([level, fields]),
      production: false,
      random: () => 0.5,
      texts: TEXTS,
      ...extra,
    });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance", "Date"] });
    calls = [];
    fanOuts = [];
    queue = [];
    acks = [];
    logs = [];
    switchOn = undefined;
    settleMore = 0;
    dueMore = 0;
    failFanOut = false;
    failDue = false;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("settles first, scans what is due, fans out, claims, then sleeps about a second when there is nothing to do", async () => {
    const worker = start([createFakeProvider("fcm")]);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(["settle", "due", "fanOut", "claim:fcm:200"]);
    await vi.advanceTimersByTimeAsync(999);
    expect(calls).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toEqual(["settle", "due", "fanOut", "claim:fcm:200", "fanOut", "claim:fcm:200"]);
    await worker.stop();
  });

  it("scans what is due every minute, at most 5 calls while one reports more, switch on or off (T-501d)", async () => {
    switchOn = false;
    dueMore = 6;
    const worker = start([createFakeProvider("fcm")]);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.filter((call) => call === "due")).toHaveLength(5);
    expect(calls.indexOf("due")).toBeLessThan(calls.indexOf("fanOut"));
    await vi.advanceTimersByTimeAsync(PUSH_DUE_MS - 2000);
    expect(calls.filter((call) => call === "due")).toHaveLength(5);
    await vi.advanceTimersByTimeAsync(3000);
    expect(calls.filter((call) => call === "due")).toHaveLength(6);
    expect(calls.filter((call) => call === "settle")).toHaveLength(1);
    await worker.stop();
  });

  it("logs a failed due scan with its SQLSTATE only and still fans out", async () => {
    failDue = true;
    const worker = start([createFakeProvider("fcm")]);
    await vi.advanceTimersByTimeAsync(0);
    expect(logs).toContainEqual(["error", { event: "push.due_failed", code: "57014" }]);
    expect(calls).toContain("fanOut");
    await worker.stop();
  });

  it("loops without sleeping while the fan-out has more or a round claimed rows", async () => {
    fanOuts = [
      { rows: 2000, more: true },
      { rows: 500, more: true },
    ];
    queue = [claimRow(1)];
    const worker = start([createFakeProvider("fcm")]);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.filter((call) => call === "fanOut")).toHaveLength(3);
    expect(acks.flat().map((row) => row.outcome)).toEqual(["sent"]);
    await worker.stop();
  });

  it("settles every 10 minutes, at most 5 calls while one reports more, switch on or off", async () => {
    switchOn = false;
    settleMore = 6;
    const worker = start([createFakeProvider("fcm")]);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.filter((call) => call === "settle")).toHaveLength(5);
    expect(calls.some((call) => call.startsWith("claim"))).toBe(false);
    expect(calls).toContain("fanOut");
    await vi.advanceTimersByTimeAsync(PUSH_SETTLE_MS - 2000);
    expect(calls.filter((call) => call === "settle")).toHaveLength(5);
    await vi.advanceTimersByTimeAsync(3000);
    expect(calls.filter((call) => call === "settle")).toHaveLength(6);
    await worker.stop();
  });

  it("claims nothing with the switch off and again once it is on", async () => {
    switchOn = false;
    const worker = start([createFakeProvider("fcm")]);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.some((call) => call.startsWith("claim"))).toBe(false);
    switchOn = true;
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls.some((call) => call.startsWith("claim"))).toBe(true);
    await worker.stop();
  });

  it("logs a failed step with its SQLSTATE only and keeps going after a pause", async () => {
    failFanOut = true;
    const worker = start([createFakeProvider("fcm")]);
    await vi.advanceTimersByTimeAsync(0);
    expect(logs).toContainEqual(["error", { event: "push.fan_out_failed", code: "57P01" }]);
    failFanOut = false;
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls.filter((call) => call === "fanOut")).toHaveLength(2);
    await worker.stop();
  });

  it("logs a failed event batch, and the parked alert at the third failure", async () => {
    fanOuts = [
      { rows: 0, more: false, failed: 41, code: "57014", parked: false },
      { rows: 0, more: false, failed: 41, code: "57014", parked: true },
    ];
    const worker = start([createFakeProvider("fcm")]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(logs).toEqual([
      ["error", { event: "push.fan_out_batch_failed", notice: 41, code: "57014" }],
      ["error", { event: "push.notice_parked", notice: 41, code: "57014" }],
    ]);
    await worker.stop();
  });

  it("stop() lets the wave in flight end, acknowledges it, closes the providers and waits", async () => {
    const provider = createFakeProvider("fcm", { latencyMs: 5000 });
    queue = Array.from({ length: 60 }, (_, i) => claimRow(i + 1));
    const worker = start([provider]);
    await vi.advanceTimersByTimeAsync(100);
    let stopped = false;
    const stopping = worker.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(4000);
    expect(stopped).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    await stopping;
    expect(acks.map((wave) => wave.length)).toEqual([50, 10]);
    expect(acks[0]?.every((row) => row.outcome === "sent")).toBe(true);
    expect(acks[1]?.every((row) => row.code === "stopping")).toBe(true);
    expect(provider.closed).toBe(true);
  });

  it("logs a platform without a provider once at start in production", async () => {
    const worker = start([createFakeProvider("fcm")], { production: true });
    expect(logs).toEqual([["warn", { event: "push.provider_missing", platform: "ios" }]]);
    await worker.stop();
    expect(missingPlatforms([])).toEqual(["ios", "android"]);
    expect(missingPlatforms([createFakeProvider("apns:sandbox")])).toEqual(["android"]);
    const quiet = start([], { production: false });
    expect(logs).toHaveLength(1);
    await quiet.stop();
  });
});
