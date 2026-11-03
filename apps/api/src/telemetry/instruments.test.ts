import { context, ROOT_CONTEXT, SpanStatusCode, trace } from "@opentelemetry/api";
import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EmailSendError } from "#src/auth/email/sender";
import { instrumentEmail, instrumentPush, instrumentSms } from "#src/telemetry/outbound";
import { watchPool } from "#src/telemetry/pool";
import { markRun, trackRun } from "#src/telemetry/runs";
import { gaugeSources } from "#src/telemetry/instruments";
import { recordTelemetry, type Recording } from "#test/support/telemetry";

let recording: Recording;

beforeEach(() => {
  recording = recordTelemetry();
});

afterEach(async () => {
  gaugeSources.lastRuns.clear();
  gaugeSources.pools.clear();
  await recording.shutdown();
});

const countsBy = async (metric: string, label: string): Promise<Record<string, unknown>> => {
  const points = (await recording.metrics()).get(metric) ?? [];
  return Object.fromEntries(points.map((point) => [String(point.attributes[label]), point.value]));
};

describe("outside providers", () => {
  it("counts an SMS by what became of it, with its duration", async () => {
    const answers = [
      { kind: "sent" },
      { kind: "unknown", reason: "timeout" },
      { kind: "sent" },
    ] as const;
    let call = 0;
    const sms = instrumentSms(
      { name: "msegat", send: async () => answers[call++] ?? { kind: "sent" } },
      "msegat",
    );
    for (let index = 0; index < 3; index++) {
      await sms.send({ to: "+966500000000", text: "x" });
    }
    expect(await countsBy("questify.outbound.requests", "questify.outcome")).toEqual({
      sent: 2,
      unknown: 1,
    });
    const durations = (await recording.metrics()).get("questify.outbound.duration") ?? [];
    expect(durations.map((point) => point.attributes["questify.provider"])).toEqual([
      "msegat",
      "msegat",
    ]);
  });

  it("counts a push by its result and keeps the provider's other fields", async () => {
    let closed = false;
    const push = instrumentPush({
      target: "apns:production",
      send: async () => ({ kind: "requeue", code: "503", written: true }),
      close: async () => {
        closed = true;
      },
    });
    const message = {
      token: "t",
      collapseId: "n1",
      priority: "high",
      expiresAt: new Date(),
      title: "t",
      body: "b",
      channel: "personal",
      threadId: "questify",
      data: {},
    } as const;
    expect(await push.send(message, new Date())).toMatchObject({ kind: "requeue" });
    await push.close();
    expect(closed).toBe(true);
    expect(push.target).toBe("apns:production");
    const [point] = (await recording.metrics()).get("questify.outbound.requests") ?? [];
    expect(point?.attributes).toEqual({
      "questify.operation": "push",
      "questify.provider": "apns:production",
      "questify.outcome": "requeue",
    });
  });

  it("counts an email that throws as failed, ends its span as an error and still throws", async () => {
    const email = instrumentEmail(
      {
        name: "gmail",
        send: async () => {
          throw new EmailSendError("gmail", "refused");
        },
      },
      "gmail",
    );
    await expect(email.send({ to: "a@b.sa", subject: "s", text: "t" })).rejects.toThrow("refused");
    expect(await countsBy("questify.outbound.requests", "questify.outcome")).toEqual({ failed: 1 });
    const [span] = recording.spans();
    expect(span?.name).toBe("email gmail");
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
  });

  it("counts an email that goes as sent", async () => {
    const email = instrumentEmail({ name: "gmail", send: async () => undefined }, "gmail");
    await email.send({ to: "a@b.sa", subject: "s", text: "t" });
    expect(await countsBy("questify.outbound.requests", "questify.outcome")).toEqual({ sent: 1 });
  });

  it("makes its span a child of the request it ran in", async () => {
    const email = instrumentEmail({ name: "gmail", send: async () => undefined }, "gmail");
    const tracer = trace.getTracer("test");
    const parent = tracer.startSpan("parent");
    await context.with(trace.setSpan(context.active(), parent), () =>
      email.send({ to: "a@b.sa", subject: "s", text: "t" }),
    );
    parent.end();
    const child = recording.spans().find((span) => span.name === "email gmail");
    expect(child?.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
  });
});

describe("background loops", () => {
  it("counts a run, times it and notes when it finished", async () => {
    const before = Date.now();
    await trackRun("community", async () => undefined);
    expect(await countsBy("questify.tick.runs", "questify.tick")).toEqual({ community: 1 });
    const lastRun = (await recording.metrics()).get("questify.tick.last_run") ?? [];
    expect(lastRun).toHaveLength(1);
    expect(lastRun[0]?.attributes).toEqual({ "questify.tick": "community" });
    expect(Number(lastRun[0]?.value)).toBeGreaterThanOrEqual(before / 1000);
    expect(Number(lastRun[0]?.value)).toBeLessThanOrEqual(Date.now() / 1000);
  });

  it("counts a run that throws as failed, rethrows, and still notes that the loop is alive", async () => {
    await expect(
      trackRun("lifecycle", async () => {
        throw new Error("down");
      }),
    ).rejects.toThrow("down");
    const [point] = (await recording.metrics()).get("questify.tick.runs") ?? [];
    expect(point?.attributes).toEqual({
      "questify.tick": "lifecycle",
      "questify.outcome": "failed",
    });
    expect(gaugeSources.lastRuns.has("lifecycle")).toBe(true);
    expect(recording.spans()[0]?.status.code).toBe(SpanStatusCode.ERROR);
  });

  it("is its own trace, whatever context it was started from", async () => {
    const outer = trace.getTracer("test").startSpan("outer");
    await context.with(trace.setSpan(ROOT_CONTEXT, outer), () =>
      trackRun("souvenir", async () => undefined),
    );
    outer.end();
    const run = recording.spans().find((span) => span.name === "tick souvenir");
    expect(run?.parentSpanContext).toBeUndefined();
    expect(run?.spanContext().traceId).not.toBe(outer.spanContext().traceId);
  });

  it("reports the last run of each loop, as seconds", async () => {
    markRun("push_worker", 1_700_000_000_000);
    markRun("ranking_repair", 1_700_000_100_000);
    const values = await countsBy("questify.tick.last_run", "questify.tick");
    expect(values).toEqual({ push_worker: 1_700_000_000, ranking_repair: 1_700_000_100 });
  });
});

const poolWith = (total: number, idle: number, waiting: number): Pool =>
  ({ totalCount: total, idleCount: idle, waitingCount: waiting }) as unknown as Pool;

describe("database pools", () => {
  it("reports the connections of each pool by state", async () => {
    watchPool("api", poolWith(10, 3, 2));
    watchPool("push", poolWith(3, 3, 0));
    const points = (await recording.metrics()).get("questify.db.pool.connections") ?? [];
    const read = Object.fromEntries(
      points.map((point) => [
        `${String(point.attributes["questify.pool"])}.${String(point.attributes["questify.pool.state"])}`,
        point.value,
      ]),
    );
    expect(read).toEqual({
      "api.total": 10,
      "api.idle": 3,
      "api.waiting": 2,
      "push.total": 3,
      "push.idle": 3,
      "push.waiting": 0,
    });
  });

  it("stops reporting a pool once it is no longer watched", async () => {
    const stop = watchPool("api", poolWith(1, 1, 0));
    stop();
    expect((await recording.metrics()).get("questify.db.pool.connections") ?? []).toEqual([]);
  });

  it("leaves a newer pool of the same name alone when an older one stops", async () => {
    const stopOld = watchPool("api", poolWith(1, 1, 0));
    watchPool("api", poolWith(5, 5, 0));
    stopOld();
    const points = (await recording.metrics()).get("questify.db.pool.connections") ?? [];
    expect(points.find((point) => point.attributes["questify.pool.state"] === "total")?.value).toBe(
      5,
    );
  });
});
