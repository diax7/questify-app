import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeProvider, type FakeProvider } from "#src/push/fake";
import type { PushMessage, PushResult } from "#src/push/provider";
import {
  ATTEMPT_MS,
  SYSTEM_CLOCK,
  sendRow,
  type Attempted,
  type SendContext,
} from "#src/push/send";
import { createTargetState, type TargetState } from "#src/push/targets";

const MESSAGE: PushMessage = {
  token: "a".repeat(64),
  collapseId: "n1",
  priority: "high",
  expiresAt: new Date("2026-10-29T00:00:00Z"),
  title: "Winter Fest",
  body: "Flash quest: Find the falcon",
  channel: "announcements",
  threadId: "questify",
  data: { n: "1", k: "flash", e: "", r: "{}" },
};

const answer = (result: PushResult) => () => result;
const FIVE_HUNDRED: PushResult = { kind: "requeue", code: "500", written: true };

const run = async (promise: Promise<Attempted>): Promise<Attempted> => {
  await vi.runAllTimersAsync();
  return promise;
};

describe("sendRow (plan § Review 3)", () => {
  let provider: FakeProvider;
  let targets: TargetState;
  let holds: string[];
  const context = (deadlineIn = 58_000): SendContext => ({
    clock: SYSTEM_CLOCK,
    targets,
    deadline: performance.now() + deadlineIn,
  });
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance", "Date"] });
    provider = createFakeProvider("apns:production");
    holds = [];
    targets = createTargetState(
      () => performance.now(),
      (fields) => holds.push(`${fields.target}:${fields.code}`),
    );
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends once and counts the attempt", async () => {
    expect(await run(sendRow(context(), provider, MESSAGE, 2))).toEqual({
      outcome: "sent",
      code: null,
      attempts: 3,
      answered: true,
      ambiguous: false,
    });
    expect(provider.sent).toHaveLength(1);
  });

  it("500 then 500 then 500: requeue, attempts 3, after waits of 1 s and 2 s", async () => {
    provider.script.push(answer(FIVE_HUNDRED), answer(FIVE_HUNDRED), answer(FIVE_HUNDRED));
    const started = performance.now();
    const times: number[] = [];
    const send = provider.send;
    const timed = {
      ...provider,
      send: (m: PushMessage, d: Date) => (times.push(performance.now() - started), send(m, d)),
    };
    const result = await run(sendRow(context(), timed, MESSAGE, 0));
    expect(result).toEqual({
      outcome: "requeue",
      code: "500",
      attempts: 3,
      answered: true,
      ambiguous: false,
    });
    expect(times).toEqual([0, 1000, 3000]);
  });

  it("a definite 500 then 200: sent with both attempts counted; Retry-After is honoured when it fits", async () => {
    provider.script.push(answer({ ...FIVE_HUNDRED, retryAfterMs: 5000 }), answer({ kind: "sent" }));
    const started = performance.now();
    const result = await run(sendRow(context(), provider, MESSAGE, 0));
    expect(result.outcome).toBe("sent");
    expect(result.attempts).toBe(2);
    expect(performance.now() - started).toBe(5000);
  });

  it("a Retry-After that does not fit the deadline requeues at once", async () => {
    provider.script.push(answer({ ...FIVE_HUNDRED, retryAfterMs: 50_000 }));
    expect(await run(sendRow(context(), provider, MESSAGE, 4))).toMatchObject({
      outcome: "requeue",
      code: "500",
      attempts: 5,
    });
    expect(provider.sent).toHaveLength(1);
  });

  it("timeout after write: unknown, never tried again", async () => {
    provider.script.push(answer({ kind: "unknown", code: "timeout" }));
    expect(await run(sendRow(context(), provider, MESSAGE, 0))).toMatchObject({
      outcome: "unknown",
      code: "timeout",
      attempts: 1,
    });
    expect(provider.sent).toHaveLength(1);
  });

  it("a provider that does not answer within 10 s is a timeout (unknown)", async () => {
    provider.latencyMs = 60_000;
    const started = performance.now();
    expect(await run(sendRow(context(), provider, MESSAGE, 0))).toMatchObject({
      outcome: "unknown",
      code: "timeout",
      attempts: 1,
    });
    expect(provider.sent[0]?.deadline.getTime()).toBe(
      Date.now() - (performance.now() - started) + ATTEMPT_MS,
    );
  });

  it("connect refused: requeue, attempts 0, no second try", async () => {
    provider.script.push(answer({ kind: "requeue", code: "connect", written: false }));
    expect(await run(sendRow(context(), provider, MESSAGE, 0))).toEqual({
      outcome: "requeue",
      code: "connect",
      attempts: 0,
      answered: false,
      ambiguous: false,
    });
    expect(provider.sent).toHaveLength(1);
  });

  it("no attempt starts that could end after the deadline: requeued untried", async () => {
    expect(await run(sendRow(context(ATTEMPT_MS - 1), provider, MESSAGE, 3))).toEqual({
      outcome: "requeue",
      code: "deadline",
      attempts: 3,
      answered: false,
      ambiguous: false,
    });
    expect(provider.sent).toHaveLength(0);
  });

  it("a row claimed at 7 attempts gets one try", async () => {
    provider.script.push(answer(FIVE_HUNDRED), answer(FIVE_HUNDRED));
    expect(await run(sendRow(context(), provider, MESSAGE, 7))).toMatchObject({
      outcome: "requeue",
      attempts: 8,
    });
    expect(provider.sent).toHaveLength(1);
  });

  it("an account refusal holds the target and requeues with no attempt; a held target is not tried again", async () => {
    provider.script.push(answer({ kind: "hold", code: "InvalidProviderToken", holdMs: 900_000 }));
    expect(await run(sendRow(context(), provider, MESSAGE, 1))).toEqual({
      outcome: "requeue",
      code: "InvalidProviderToken",
      attempts: 1,
      answered: true,
      ambiguous: false,
    });
    expect(holds).toEqual(["apns:production:InvalidProviderToken"]);
    expect(targets.held("apns:production")).toBe(true);
    expect(await run(sendRow(context(), provider, MESSAGE, 1))).toMatchObject({
      outcome: "requeue",
      code: "hold",
    });
    expect(provider.sent).toHaveLength(1);
  });

  it("a held target between in-lease tries stops the row", async () => {
    provider.script.push((): PushResult => {
      targets.hold("apns:production", 5000, "breaker");
      return FIVE_HUNDRED;
    });
    expect(await run(sendRow(context(), provider, MESSAGE, 0))).toMatchObject({
      outcome: "requeue",
      code: "hold",
      attempts: 1,
    });
  });

  it("maps refusals and invalid tokens", async () => {
    provider.script.push(
      answer({ kind: "failed", code: "PayloadTooLarge" }),
      answer({ kind: "invalid_token", code: "Unregistered", ambiguous: false }),
      answer({ kind: "invalid_token", code: "BadDeviceToken", ambiguous: true }),
    );
    expect(await run(sendRow(context(), provider, MESSAGE, 0))).toMatchObject({
      outcome: "failed",
      attempts: 1,
    });
    expect(await run(sendRow(context(), provider, MESSAGE, 0))).toMatchObject({
      outcome: "invalid",
      code: "Unregistered",
      ambiguous: false,
    });
    expect(await run(sendRow(context(), provider, MESSAGE, 0))).toMatchObject({
      outcome: "invalid",
      code: "BadDeviceToken",
      ambiguous: true,
      answered: true,
    });
  });

  it("a provider that throws counts as a timeout", async () => {
    const broken = { ...provider, send: () => Promise.reject(new Error("boom")) };
    expect(await run(sendRow(context(), broken, MESSAGE, 0))).toMatchObject({
      outcome: "unknown",
      code: "timeout",
    });
  });
});
