import { MESSAGES, type PushTexts } from "@questify/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AckRow, PushDoors } from "#src/push/doors";
import { createFakeProvider, type FakeProvider } from "#src/push/fake";
import type { ClaimedSend } from "#src/push/message";
import type { PushProvider, PushResult, PushTarget } from "#src/push/provider";
import { runRound, type RoundDeps } from "#src/push/round";
import { SYSTEM_CLOCK } from "#src/push/send";
import { createTargetState, type TargetState } from "#src/push/targets";

const TEXTS: PushTexts = {
  messages: {
    ...MESSAGES,
    "push.t.body": { ar: "رسالة", en: "A message" },
    "push.t.nameless": { ar: "رسالة", en: "A message" },
  },
  templates: { test_kind: { body: "push.t.body", nameless: "push.t.nameless" } },
};

let serial = 0;
const row = (target: PushTarget, over: Partial<ClaimedSend> = {}): ClaimedSend => {
  serial += 1;
  return {
    send_id: String(serial),
    lease: `00000000-0000-4000-8000-${String(serial).padStart(12, "0")}`,
    lease_until: new Date(Date.now() + 60_000),
    target,
    token: "a".repeat(64),
    language: "en",
    kind: "test_kind",
    class: "personal",
    topic: null,
    notification_id: String(serial),
    event_id: null,
    refs: {},
    params: {},
    expires_at: new Date(Date.now() + 3_600_000),
    priority: 0,
    attempts: 0,
    terms: null,
    timezone: null,
    ...over,
  };
};

const round = async (roundDeps: RoundDeps): Promise<number> => {
  const done = runRound(roundDeps);
  await vi.runAllTimersAsync();
  return done;
};

describe("runRound (plan § Review 3 and 4)", () => {
  let acks: AckRow[][];
  let claimed: ClaimedSend[];
  let claimedTargets: PushTarget[][];
  let targets: TargetState;
  let logs: Array<Record<string, unknown>>;
  let stopping: boolean;
  let ackFails: boolean;

  const doors: PushDoors = {
    fanOut: () => Promise.resolve({ rows: 0, more: false }),
    claim: (asked) => {
      claimedTargets.push([...asked]);
      return Promise.resolve(claimed.filter((one) => asked.includes(one.target as PushTarget)));
    },
    ack: (rows) => {
      acks.push([...rows]);
      return ackFails
        ? Promise.reject(Object.assign(new Error("down"), { code: "57P01" }))
        : Promise.resolve(rows.length);
    },
    settle: () => Promise.resolve({}),
    due: () => Promise.resolve({}),
  };
  const deps = (...providers: PushProvider[]): RoundDeps => ({
    doors,
    providers: new Map(providers.map((one) => [one.target, one])),
    targets,
    clock: SYSTEM_CLOCK,
    log: (_level, fields) => logs.push(fields),
    stopped: () => stopping,
    texts: TEXTS,
  });
  const outcomes = () => acks.flat().map((one) => `${one.outcome}:${one.code}:${one.attempts}`);

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance", "Date"] });
    acks = [];
    claimed = [];
    claimedTargets = [];
    logs = [];
    stopping = false;
    ackFails = false;
    targets = createTargetState(
      () => performance.now(),
      (fields) => logs.push(fields),
    );
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("four waves of 50: four acks, at most 50 in flight", async () => {
    const provider = createFakeProvider("apns:production", { latencyMs: 100 });
    for (let i = 0; i < 200; i += 1) claimed.push(row("apns:production"));
    let inFlight = 0;
    let most = 0;
    const counting: PushProvider = {
      ...provider,
      send: async (message, deadline) => {
        inFlight += 1;
        most = Math.max(most, inFlight);
        const result = await provider.send(message, deadline);
        inFlight -= 1;
        return result;
      },
    };
    expect(await round(deps(counting))).toBe(200);
    expect(acks.map((wave) => wave.length)).toEqual([50, 50, 50, 50]);
    expect(most).toBe(50);
    expect(outcomes().every((one) => one === "sent:null:1")).toBe(true);
  });

  it("a 33 s slow provider: no attempt starts after lease_until − 12 s, those rows are requeued, none becomes unknown", async () => {
    const provider = createFakeProvider("fcm", { latencyMs: 9900 });
    const fiveHundred: PushResult = { kind: "requeue", code: "500", written: true };
    for (let i = 0; i < 400; i += 1) provider.script.push(() => fiveHundred);
    for (let i = 0; i < 150; i += 1) claimed.push(row("fcm"));
    // The breaker would hold the target after 10 answers; this test is about the deadline alone.
    targets = { ...targets, failure: () => undefined };
    const started = performance.now();
    const starts: number[] = [];
    const timed: PushProvider = {
      ...provider,
      send: (message, deadline) => {
        starts.push(performance.now() - started);
        return provider.send(message, deadline);
      },
    };
    await round(deps(timed));
    expect(Math.max(...starts)).toBeLessThanOrEqual(48_000);
    const all = acks.flat();
    expect(all).toHaveLength(150);
    expect(all.some((one) => one.outcome === "unknown")).toBe(false);
    expect(new Set(all.map((one) => one.outcome))).toEqual(new Set(["requeue"]));
    expect(all.slice(0, 50).every((one) => one.attempts === 3)).toBe(true);
    expect(all.slice(50, 100).every((one) => one.attempts === 2)).toBe(true);
    expect(all.slice(100).every((one) => one.attempts === 0 && one.code === "deadline")).toBe(true);
  });

  /** One round of 100 slow rows whose lease the database put `shift` milliseconds later; the acknowledgements. */
  const runWith = async (shift: number) => {
    serial = 0;
    acks = [];
    claimed = [];
    targets = {
      ...createTargetState(
        () => performance.now(),
        () => undefined,
      ),
      failure: () => undefined,
    };
    const provider = createFakeProvider("fcm", { latencyMs: 10_000 });
    for (let i = 0; i < 400; i += 1) {
      provider.script.push(() => ({ kind: "requeue", code: "503", written: true }));
    }
    for (let i = 0; i < 100; i += 1) {
      claimed.push(row("fcm", { lease_until: new Date(Date.now() + 60_000 + shift) }));
    }
    await round(deps(provider));
    return outcomes();
  };

  it("a database clock 30 s ahead of the host changes no deadline", async () => {
    expect(await runWith(30_000)).toEqual(await runWith(0));
  });

  it("10 consecutive 503: the target is held and its later waves are requeued untried", async () => {
    const provider = createFakeProvider("fcm");
    for (let i = 0; i < 50 * 3; i += 1)
      provider.script.push(() => ({ kind: "requeue", code: "503", written: true }));
    for (let i = 0; i < 100; i += 1) claimed.push(row("fcm"));
    await round(deps(provider));
    expect(targets.held("fcm")).toBe(true);
    expect(logs).toContainEqual({ event: "push.provider_hold", target: "fcm", code: "breaker" });
    expect(acks[1]?.every((one) => one.code === "hold" && one.attempts === 0)).toBe(true);
  });

  it("120 answers, 100 Unregistered: 100 devices invalid, no hold", async () => {
    const provider = createFakeProvider("apns:production");
    for (let i = 0; i < 100; i += 1) {
      provider.script.push(() => ({
        kind: "invalid_token",
        code: "Unregistered",
        ambiguous: false,
      }));
    }
    for (let i = 0; i < 120; i += 1) claimed.push(row("apns:production"));
    await round(deps(provider));
    const all = acks.flat();
    expect(all.filter((one) => one.outcome === "invalid")).toHaveLength(100);
    expect(all.filter((one) => one.outcome === "sent")).toHaveLength(20);
    expect(targets.held("apns:production")).toBe(false);
  });

  it("40 answers, 25 BadDeviceToken: held, nothing invalid, 25 requeued", async () => {
    const provider = createFakeProvider("apns:sandbox");
    for (let i = 0; i < 25; i += 1) {
      provider.script.push(() => ({
        kind: "invalid_token",
        code: "BadDeviceToken",
        ambiguous: true,
      }));
    }
    for (let i = 0; i < 40; i += 1) claimed.push(row("apns:sandbox"));
    await round(deps(provider));
    const all = acks.flat();
    expect(all.filter((one) => one.outcome === "invalid")).toEqual([]);
    expect(
      all.filter((one) => one.outcome === "requeue" && one.code === "mass_invalid"),
    ).toHaveLength(25);
    expect(targets.held("apns:sandbox")).toBe(true);
    expect(logs).toContainEqual({ event: "push.mass_invalid", target: "apns:sandbox" });
  });

  it("a few ambiguous answers below the guard invalidate their devices", async () => {
    const provider = createFakeProvider("fcm");
    for (let i = 0; i < 3; i += 1) {
      provider.script.push(() => ({
        kind: "invalid_token",
        code: "SENDER_ID_MISMATCH",
        ambiguous: true,
      }));
    }
    for (let i = 0; i < 30; i += 1) claimed.push(row("fcm"));
    await round(deps(provider));
    expect(acks.flat().filter((one) => one.outcome === "invalid")).toHaveLength(3);
    expect(targets.held("fcm")).toBe(false);
  });

  it("apns:sandbox held: apns:production and fcm still claimed", async () => {
    targets.hold("apns:sandbox", 60_000, "mass_invalid");
    claimed.push(row("apns:production"), row("fcm"));
    const all = [
      createFakeProvider("apns:production"),
      createFakeProvider("apns:sandbox"),
      createFakeProvider("fcm"),
    ];
    expect(await round(deps(...all))).toBe(2);
    expect(claimedTargets).toEqual([["apns:production", "fcm"]]);
  });

  it("claims nothing when every target is held or there is no provider", async () => {
    expect(await round(deps())).toBe(0);
    targets.hold("fcm", 60_000, "QUOTA_EXCEEDED");
    expect(await round(deps(createFakeProvider("fcm")))).toBe(0);
    expect(claimedTargets).toEqual([]);
  });

  it("fails a kind without a template untried, and requeues the rest of the round once the worker stops", async () => {
    const provider = createFakeProvider("fcm");
    const stopper: PushProvider = {
      ...provider,
      send: (message, deadline) => {
        stopping = true;
        return provider.send(message, deadline);
      },
    };
    claimed.push(row("fcm", { kind: "no_such_template", attempts: 2 }));
    for (let i = 0; i < 60; i += 1) claimed.push(row("fcm"));
    await round(deps(stopper));
    expect(acks[0]?.[0]).toMatchObject({ outcome: "failed", code: "no_template", attempts: 2 });
    expect(acks[0]?.slice(1).every((one) => one.outcome === "sent")).toBe(true);
    expect(acks[1]?.every((one) => one.outcome === "requeue" && one.code === "stopping")).toBe(
      true,
    );
    expect(provider.sent).toHaveLength(49);
  });

  it("logs a failed acknowledgement and goes on", async () => {
    ackFails = true;
    claimed.push(row("fcm"));
    await round(deps(createFakeProvider("fcm")));
    expect(logs).toContainEqual({ event: "push.ack_failed", code: "57P01", rows: 1 });
  });
});

describe("FakeProvider", () => {
  it("records, answers its script and closes", async () => {
    const fake: FakeProvider = createFakeProvider("fcm");
    fake.script.push(() => ({ kind: "failed", code: "x" }));
    const message = {
      token: "t",
      collapseId: "n1",
      priority: "high" as const,
      expiresAt: new Date(0),
      title: "a",
      body: "b",
      channel: "personal",
      threadId: "questify",
      data: {},
    };
    expect(await fake.send(message, new Date(0))).toEqual({ kind: "failed", code: "x" });
    expect(await fake.send(message, new Date(0))).toEqual({ kind: "sent" });
    await fake.close();
    expect(fake.closed).toBe(true);
    expect(fake.sent).toHaveLength(2);
  });
});
